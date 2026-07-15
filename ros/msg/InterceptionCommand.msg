# CREBAIN Interception Command Message
# Command to initiate or update an interception

std_msgs/Header header

# Target drone ID
string target_id

# Interceptor drone ID
string interceptor_id

# Calculated intercept point
geometry_msgs/Point intercept_point

# Estimated time to intercept
duration time_to_intercept

# Interception strategy: PURSUIT, LEAD, PARALLEL, or AMBUSH.
# This reference contract mirrors the canonical TypeScript string union.
string strategy
