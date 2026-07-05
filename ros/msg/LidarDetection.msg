# CREBAIN LIDAR Detection Message
# Single clustered LIDAR detection

std_msgs/Header header

# Unique detection ID
string id

# Cluster centroid in sensor frame (Cartesian, meters)
geometry_msgs/Point centroid

# Axis-aligned bounding box in sensor frame (Cartesian, meters)
geometry_msgs/Point bbox_min
geometry_msgs/Point bbox_max

# Estimated velocity (Cartesian, m/s)
geometry_msgs/Vector3 velocity

# Position covariance diagonal [x, y, z] in m^2
float64[3] covariance

# Number of points in the cluster
uint32 num_points

# Detection confidence [0.0 - 1.0]
float64 confidence

# Classification label
string classification
