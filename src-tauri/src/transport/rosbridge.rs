//! Rosbridge WebSocket Transport
//!
//! Fallback transport when Zenoh is unavailable. Connects to a
//! rosbridge_server via WebSocket and provides pub/sub for ROS topics.
//!
//! # Protocol
//! rosbridge v2.0 protocol using JSON messages over WebSocket.
//! See: https://github.com/RobotWebTools/rosbridge_suite

use super::{
    CameraFrame, CameraInfoData, ImuData, ModelStates, PoseData, Result, Transport,
    TransportError, TransportStats, TwistStampedData, VelocityCmd,
};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const MAX_TOPIC_LEN: usize = 256;
const MAX_MESSAGE_TYPE_LEN: usize = 128;
const DEFAULT_ROSBRIDGE_URL: &str = "ws://localhost:9090";

pub fn validate_topic_for_test(topic: &str) -> Result<()> {
    validate_topic(topic)
}

pub fn validate_message_type_for_test(msg_type: &str) -> Result<()> {
    validate_message_type(msg_type)
}

fn validate_topic(topic: &str) -> Result<()> {
    if topic.is_empty() || topic.len() > MAX_TOPIC_LEN {
        return Err(TransportError::SubscriptionFailed(format!(
            "Invalid topic length: {}",
            topic.len()
        )));
    }
    if !topic.starts_with('/') {
        return Err(TransportError::SubscriptionFailed(
            "Topic must start with '/'".to_string(),
        ));
    }
    if topic.contains("//") || topic.contains('\0') {
        return Err(TransportError::SubscriptionFailed(format!(
            "Invalid topic: {}",
            topic
        )));
    }
    Ok(())
}

fn validate_message_type(msg_type: &str) -> Result<()> {
    if msg_type.is_empty() || msg_type.len() > MAX_MESSAGE_TYPE_LEN {
        return Err(TransportError::PublishFailed(format!(
            "Invalid message type length: {}",
            msg_type.len()
        )));
    }
    if !msg_type.contains('/') {
        return Err(TransportError::PublishFailed(format!(
            "Message type must contain '/': {}",
            msg_type
        )));
    }
    Ok(())
}

type SubscriptionCallback = Box<dyn Fn(serde_json::Value) + Send + Sync>;

struct RosbridgeInner {
    write_tx: mpsc::UnboundedSender<String>,
    connected: AtomicBool,
    messages_received: AtomicU64,
    messages_sent: AtomicU64,
    bytes_received: AtomicU64,
    bytes_sent: AtomicU64,
    connect_time: Instant,
    subscriptions: Mutex<HashMap<String, SubscriptionCallback>>,
}

pub struct RosbridgeTransport {
    inner: Arc<RosbridgeInner>,
}

impl RosbridgeTransport {
    pub async fn connect(url: Option<&str>) -> Result<Self> {
        let ws_url = url.unwrap_or(DEFAULT_ROSBRIDGE_URL);

        let (ws_stream, _) = connect_async(ws_url)
            .await
            .map_err(|e| TransportError::ConnectionFailed(format!("WebSocket connect failed: {}", e)))?;

        let (mut write, mut read) = ws_stream.split();
        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<String>();

        let inner = Arc::new(RosbridgeInner {
            write_tx,
            connected: AtomicBool::new(true),
            messages_received: AtomicU64::new(0),
            messages_sent: AtomicU64::new(0),
            bytes_received: AtomicU64::new(0),
            bytes_sent: AtomicU64::new(0),
            connect_time: Instant::now(),
            subscriptions: Mutex::new(HashMap::new()),
        });

        let inner_clone = Arc::clone(&inner);

        // Write task
        tokio::spawn(async move {
            while let Some(msg) = write_rx.recv().await {
                let len = msg.len() as u64;
                if let Err(e) = write.send(Message::Text(msg.into())).await {
                    log::error!("[Rosbridge] Write error: {}", e);
                    break;
                }
                inner_clone.bytes_sent.fetch_add(len, Ordering::Relaxed);
                inner_clone.messages_sent.fetch_add(1, Ordering::Relaxed);
            }
            inner_clone.connected.store(false, Ordering::Relaxed);
        });

        let inner_clone2 = Arc::clone(&inner);

        // Read task
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        let len = text.len() as u64;
                        inner_clone2.bytes_received.fetch_add(len, Ordering::Relaxed);
                        inner_clone2.messages_received.fetch_add(1, Ordering::Relaxed);

                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(topic) = value.get("topic").and_then(|v| v.as_str()) {
                                let subs = inner_clone2.subscriptions.lock().unwrap();
                                if let Some(callback) = subs.get(topic) {
                                    callback(value);
                                }
                            }
                        }
                    }
                    Ok(Message::Close(_)) => {
                        log::info!("[Rosbridge] Connection closed by server");
                        break;
                    }
                    Err(e) => {
                        log::error!("[Rosbridge] Read error: {}", e);
                        break;
                    }
                    _ => {}
                }
            }
            inner_clone2.connected.store(false, Ordering::Relaxed);
        });

        Ok(Self { inner })
    }

    fn send_json(&self, msg: serde_json::Value) -> Result<()> {
        if !self.inner.connected.load(Ordering::Relaxed) {
            return Err(TransportError::PublishFailed("Not connected".to_string()));
        }
        let text = serde_json::to_string(&msg)
            .map_err(|e| TransportError::PublishFailed(format!("JSON encode: {}", e)))?;
        self.inner
            .write_tx
            .send(text)
            .map_err(|e| TransportError::PublishFailed(format!("Send error: {}", e)))?;
        Ok(())
    }
}

impl Transport for RosbridgeTransport {
    fn connect(&mut self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            if self.inner.connected.load(Ordering::Relaxed) {
                return Ok(());
            }
            Err(TransportError::ConnectionFailed(
                "Reconnection not supported; create a new RosbridgeTransport".to_string(),
            ))
        })
    }

    fn disconnect(&mut self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            self.inner.connected.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn is_connected(&self) -> bool {
        self.inner.connected.load(Ordering::Relaxed)
    }

    fn subscribe_camera(
        &self,
        topic: &str,
        callback: super::CameraCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            let subscribe_msg = serde_json::json!({
                "op": "subscribe",
                "topic": topic,
                "type": "sensor_msgs/msg/Image"
            });
            self.send_json(subscribe_msg)?;

            let mut subs = self.inner.subscriptions.lock().unwrap();
            subs.insert(
                topic,
                Box::new(move |value: serde_json::Value| {
                    if let Some(msg) = value.get("msg") {
                        let frame = CameraFrame {
                            data: msg
                                .get("data")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            width: msg.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                            height: msg.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                            encoding: msg
                                .get("encoding")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            timestamp: msg
                                .get("header")
                                .and_then(|h| h.get("stamp"))
                                .and_then(|s| s.get("secs"))
                                .and_then(|v| v.as_f64())
                                .unwrap_or(0.0),
                            frame_id: msg
                                .get("header")
                                .and_then(|h| h.get("frame_id"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            is_bigendian: msg
                                .get("is_bigendian")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) as u8,
                            step: msg
                                .get("step")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) as u32,
                        };
                        callback(frame);
                    }
                }),
            );
            Ok(())
        })
    }

    fn subscribe_camera_info(
        &self,
        topic: &str,
        callback: super::CameraInfoCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            let subscribe_msg = serde_json::json!({
                "op": "subscribe",
                "topic": topic,
                "type": "sensor_msgs/msg/CameraInfo"
            });
            self.send_json(subscribe_msg)?;

            let mut subs = self.inner.subscriptions.lock().unwrap();
            subs.insert(
                topic,
                Box::new(move |value: serde_json::Value| {
                    if let Some(msg) = value.get("msg") {
                        let info = CameraInfoData {
                            height: msg.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                            width: msg.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                            distortion_model: msg
                                .get("distortion_model")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            d: msg
                                .get("d")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect())
                                .unwrap_or_default(),
                            k: [0.0f64; 9],
                            r: [0.0f64; 9],
                            p: [0.0f64; 12],
                            timestamp: msg
                                .get("header")
                                .and_then(|h| h.get("stamp"))
                                .and_then(|s| s.get("secs"))
                                .and_then(|v| v.as_f64())
                                .unwrap_or(0.0),
                            frame_id: msg
                                .get("header")
                                .and_then(|h| h.get("frame_id"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                        };
                        callback(info);
                    }
                }),
            );
            Ok(())
        })
    }

    fn subscribe_imu(
        &self,
        topic: &str,
        callback: super::ImuCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            let subscribe_msg = serde_json::json!({
                "op": "subscribe",
                "topic": topic,
                "type": "sensor_msgs/msg/Imu"
            });
            self.send_json(subscribe_msg)?;

            let mut subs = self.inner.subscriptions.lock().unwrap();
            subs.insert(
                topic,
                Box::new(move |value: serde_json::Value| {
                    if let Some(msg) = value.get("msg") {
                        let imu = ImuData {
                            orientation: [
                                msg.pointer("/orientation/x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                msg.pointer("/orientation/y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                msg.pointer("/orientation/z").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                msg.pointer("/orientation/w").and_then(|v| v.as_f64()).unwrap_or(1.0),
                            ],
                            angular_velocity: [
                                msg.pointer("/angular_velocity/x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                msg.pointer("/angular_velocity/y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                msg.pointer("/angular_velocity/z").and_then(|v| v.as_f64()).unwrap_or(0.0),
                            ],
                            linear_acceleration: [
                                msg.pointer("/linear_acceleration/x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                msg.pointer("/linear_acceleration/y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                msg.pointer("/linear_acceleration/z").and_then(|v| v.as_f64()).unwrap_or(0.0),
                            ],
                            timestamp: msg
                                .get("header")
                                .and_then(|h| h.get("stamp"))
                                .and_then(|s| s.get("secs"))
                                .and_then(|v| v.as_f64())
                                .unwrap_or(0.0),
                        };
                        callback(imu);
                    }
                }),
            );
            Ok(())
        })
    }

    fn subscribe_pose(
        &self,
        topic: &str,
        callback: super::PoseCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            let subscribe_msg = serde_json::json!({
                "op": "subscribe",
                "topic": topic,
                "type": "geometry_msgs/msg/PoseStamped"
            });
            self.send_json(subscribe_msg)?;

            let mut subs = self.inner.subscriptions.lock().unwrap();
            subs.insert(
                topic,
                Box::new(move |value: serde_json::Value| {
                    if let Some(msg) = value.get("msg") {
                        if let Some(pose) = msg.get("pose") {
                            let pose_data = PoseData {
                                position: [
                                    pose.pointer("/position/x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                    pose.pointer("/position/y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                    pose.pointer("/position/z").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                ],
                                orientation: [
                                    pose.pointer("/orientation/x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                    pose.pointer("/orientation/y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                    pose.pointer("/orientation/z").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                    pose.pointer("/orientation/w").and_then(|v| v.as_f64()).unwrap_or(1.0),
                                ],
                                timestamp: msg
                                    .get("header")
                                    .and_then(|h| h.get("stamp"))
                                    .and_then(|s| s.get("secs"))
                                    .and_then(|v| v.as_f64())
                                    .unwrap_or(0.0),
                                frame_id: msg
                                    .get("header")
                                    .and_then(|h| h.get("frame_id"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                            };
                            callback(pose_data);
                        }
                    }
                }),
            );
            Ok(())
        })
    }

    fn subscribe_model_states(
        &self,
        topic: &str,
        callback: super::ModelStatesCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            let subscribe_msg = serde_json::json!({
                "op": "subscribe",
                "topic": topic,
                "type": "gazebo_msgs/msg/ModelStates"
            });
            self.send_json(subscribe_msg)?;

            let mut subs = self.inner.subscriptions.lock().unwrap();
            subs.insert(
                topic,
                Box::new(move |value: serde_json::Value| {
                    if let Some(msg) = value.get("msg") {
                        let names: Vec<String> = msg
                            .get("name")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default();

                        let poses: Vec<PoseData> = msg
                            .get("pose")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .map(|p| PoseData {
                                        position: [
                                            p.pointer("/position/x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            p.pointer("/position/y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            p.pointer("/position/z").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                        ],
                                        orientation: [
                                            p.pointer("/orientation/x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            p.pointer("/orientation/y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            p.pointer("/orientation/z").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            p.pointer("/orientation/w").and_then(|v| v.as_f64()).unwrap_or(1.0),
                                        ],
                                        timestamp: 0.0,
                                        frame_id: String::new(),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();

                        let twists: Vec<VelocityCmd> = msg
                            .get("twist")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .map(|t| VelocityCmd {
                                        linear: [
                                            t.pointer("/linear/x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            t.pointer("/linear/y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            t.pointer("/linear/z").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                        ],
                                        angular: [
                                            t.pointer("/angular/x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            t.pointer("/angular/y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            t.pointer("/angular/z").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                        ],
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();

                        callback(ModelStates {
                            name: names,
                            pose: poses,
                            twist: twists,
                        });
                    }
                }),
            );
            Ok(())
        })
    }

    fn unsubscribe(&self, topic: &str) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            let unsubscribe_msg = serde_json::json!({
                "op": "unsubscribe",
                "topic": topic
            });
            self.send_json(unsubscribe_msg)?;
            let mut subs = self.inner.subscriptions.lock().unwrap();
            subs.remove(&topic);
            Ok(())
        })
    }

    fn publish_velocity(
        &self,
        topic: &str,
        cmd: VelocityCmd,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            validate_message_type("geometry_msgs/Twist")?;
            let publish_msg = serde_json::json!({
                "op": "publish",
                "topic": topic,
                "msg": {
                    "linear": { "x": cmd.linear[0], "y": cmd.linear[1], "z": cmd.linear[2] },
                    "angular": { "x": cmd.angular[0], "y": cmd.angular[1], "z": cmd.angular[2] }
                }
            });
            self.send_json(publish_msg)
        })
    }

    fn publish_twist_stamped(
        &self,
        topic: &str,
        cmd: TwistStampedData,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            validate_message_type("geometry_msgs/TwistStamped")?;
            let publish_msg = serde_json::json!({
                "op": "publish",
                "topic": topic,
                "msg": {
                    "header": {
                        "stamp": { "secs": cmd.timestamp as u64, "nsecs": 0u32 },
                        "frame_id": cmd.frame_id
                    },
                    "twist": {
                        "linear": { "x": cmd.twist.linear[0], "y": cmd.twist.linear[1], "z": cmd.twist.linear[2] },
                        "angular": { "x": cmd.twist.angular[0], "y": cmd.twist.angular[1], "z": cmd.twist.angular[2] }
                    }
                }
            });
            self.send_json(publish_msg)
        })
    }

    fn publish_pose(
        &self,
        topic: &str,
        pose: PoseData,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            validate_message_type("geometry_msgs/PoseStamped")?;
            let publish_msg = serde_json::json!({
                "op": "publish",
                "topic": topic,
                "msg": {
                    "header": {
                        "stamp": { "secs": pose.timestamp as u64, "nsecs": 0u32 },
                        "frame_id": pose.frame_id
                    },
                    "pose": {
                        "position": { "x": pose.position[0], "y": pose.position[1], "z": pose.position[2] },
                        "orientation": { "x": pose.orientation[0], "y": pose.orientation[1], "z": pose.orientation[2], "w": pose.orientation[3] }
                    }
                }
            });
            self.send_json(publish_msg)
        })
    }

    fn call_service<'a>(
        &'a self,
        service: &'a str,
        service_type: &'a str,
        args: serde_json::Value,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        let service = service.to_string();
        let service_type = service_type.to_string();
        Box::pin(async move {
            validate_topic(&service)?;
            validate_message_type(&service_type)?;
            let call_msg = serde_json::json!({
                "op": "call_service",
                "service": service,
                "type": service_type,
                "args": args
            });
            self.send_json(call_msg)
        })
    }

    fn stats(&self) -> TransportStats {
        TransportStats {
            messages_received: self.inner.messages_received.load(Ordering::Relaxed),
            messages_sent: self.inner.messages_sent.load(Ordering::Relaxed),
            avg_latency_ms: 0.0,
            bytes_received: self.inner.bytes_received.load(Ordering::Relaxed),
            bytes_sent: self.inner.bytes_sent.load(Ordering::Relaxed),
            uptime_secs: self.inner.connect_time.elapsed().as_secs_f64(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_topic_accepts_valid() {
        assert!(validate_topic("/drone1/camera").is_ok());
        assert!(validate_topic("/a").is_ok());
    }

    #[test]
    fn validate_topic_rejects_empty() {
        assert!(validate_topic("").is_err());
    }

    #[test]
    fn validate_topic_rejects_no_leading_slash() {
        assert!(validate_topic("drone1/camera").is_err());
    }

    #[test]
    fn validate_topic_rejects_double_slash() {
        assert!(validate_topic("/drone1//camera").is_err());
    }

    #[test]
    fn validate_topic_rejects_null_byte() {
        assert!(validate_topic("/drone\0").is_err());
    }

    #[test]
    fn validate_message_type_accepts_valid() {
        assert!(validate_message_type("sensor_msgs/Image").is_ok());
    }

    #[test]
    fn validate_message_type_rejects_no_slash() {
        assert!(validate_message_type("Image").is_err());
    }
}
