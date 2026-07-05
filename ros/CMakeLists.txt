cmake_minimum_required(VERSION 3.0.2)
project(crebain_msgs)

## Find catkin macros and libraries
find_package(catkin REQUIRED COMPONENTS
  std_msgs
  geometry_msgs
  sensor_msgs
  message_generation
)

## Generate messages in the 'msg' folder
add_message_files(
  FILES
  AcousticDetection.msg
  AcousticDetectionArray.msg
  DroneTarget.msg
  InterceptionCommand.msg
  InterceptionStatus.msg
  LidarDetection.msg
  LidarDetectionArray.msg
  RadarDetection.msg
  RadarDetectionArray.msg
  ThermalDetection.msg
  ThermalDetectionArray.msg
)

## Generate services in the 'srv' folder
add_service_files(
  FILES
  AbortMission.srv
  InitiateIntercept.srv
)

## Generate added messages and services
generate_messages(
  DEPENDENCIES
  std_msgs
  geometry_msgs
  sensor_msgs
)

## Declare catkin package
catkin_package(
  CATKIN_DEPENDS message_runtime std_msgs geometry_msgs sensor_msgs
)

## Install launch files
install(DIRECTORY launch/
  DESTINATION ${CATKIN_PACKAGE_SHARE_DESTINATION}/launch
)

## Install msg and srv files
install(DIRECTORY msg/
  DESTINATION ${CATKIN_PACKAGE_SHARE_DESTINATION}/msg
)
install(DIRECTORY srv/
  DESTINATION ${CATKIN_PACKAGE_SHARE_DESTINATION}/srv
)
