# CREBAIN Drone Target Message
# Tracked drone target with threat assessment

std_msgs/Header header

# Unique target ID
string id

# Pose (position and orientation)
geometry_msgs/Pose pose

# Velocity
geometry_msgs/Twist velocity

# Classification (e.g., "quadcopter", "fixed_wing", "loitering_munition")
string classification

# Detection confidence [0.0 - 1.0]
float64 confidence

# Threat level
uint8 THREAT_LOW = 1
uint8 THREAT_MEDIUM = 2
uint8 THREAT_HIGH = 3
uint8 THREAT_CRITICAL = 4
uint8 threat_level

# Is hostile flag
bool is_hostile
