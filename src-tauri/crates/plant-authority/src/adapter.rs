//! Inert adapter used to prove that the headless kernel has no actuator path.

use std::fmt;

/// Observable state of the inert adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdapterState {
    /// The adapter has not been started.
    Created,
    /// The adapter is ready for self-checks but exposes no action operation.
    ReadyInert,
    /// The adapter has completed its idempotent stop operation.
    Stopped,
}

/// Error returned for an invalid inert-adapter lifecycle operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdapterError {
    current: AdapterState,
    operation: &'static str,
}

impl AdapterError {
    /// Returns the adapter state in which the operation was rejected.
    #[must_use]
    pub const fn current(self) -> AdapterState {
        self.current
    }

    /// Returns the rejected lifecycle operation.
    #[must_use]
    pub const fn operation(self) -> &'static str {
        self.operation
    }
}

impl fmt::Display for AdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "inert adapter cannot {} while in {:?}",
            self.operation, self.current
        )
    }
}

impl std::error::Error for AdapterError {}

/// Adapter with lifecycle observability and intentionally no action API.
#[derive(Debug)]
pub struct InertAdapter {
    state: AdapterState,
}

impl Default for InertAdapter {
    fn default() -> Self {
        Self {
            state: AdapterState::Created,
        }
    }
}

impl InertAdapter {
    /// Creates an adapter that is disconnected from every vehicle interface.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            state: AdapterState::Created,
        }
    }

    /// Returns the current inert lifecycle state.
    #[must_use]
    pub const fn state(&self) -> AdapterState {
        self.state
    }

    /// Starts the inert adapter.
    ///
    /// # Errors
    ///
    /// Returns [`AdapterError`] unless the adapter is newly created.
    pub fn start(&mut self) -> Result<(), AdapterError> {
        if self.state != AdapterState::Created {
            return Err(AdapterError {
                current: self.state,
                operation: "start",
            });
        }
        self.state = AdapterState::ReadyInert;
        Ok(())
    }

    /// Stops the inert adapter. Repeated stop requests are idempotent.
    pub fn stop(&mut self) {
        self.state = AdapterState::Stopped;
    }
}
