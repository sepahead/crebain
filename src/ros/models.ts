/**
 * CREBAIN Gazebo Models
 * SDF definitions for spawning models directly from the UI
 */

import { DRONE_TYPES } from '../physics/DroneTypes'

const maverickPhysics = DRONE_TYPES['maverick'].physics
// Fallback for armLength if undefined
const armLength = maverickPhysics.armLength ?? 0.175

export const MAVERICK_SDF = `<?xml version="1.0" ?>
<sdf version="1.5">
  <model name="maverick-drone">
    <pose>0 0 0.2 0 0 0</pose>
    
    <link name="base_link">
      <inertial>
        <mass>${maverickPhysics.mass}</mass>
        <inertia>
          <ixx>${maverickPhysics.momentOfInertia.x}</ixx>
          <ixy>0</ixy>
          <ixz>0</ixz>
          <iyy>${maverickPhysics.momentOfInertia.y}</iyy>
          <iyz>0</iyz>
          <izz>${maverickPhysics.momentOfInertia.z}</izz>
        </inertia>
      </inertial>
      
      <collision name="base_link_collision">
        <geometry>
          <box>
            <size>${maverickPhysics.dimensions.x} ${maverickPhysics.dimensions.y} ${maverickPhysics.dimensions.z}</size>
          </box>
        </geometry>
        <surface>
          <contact>
            <ode>
              <min_depth>0.001</min_depth>
              <max_vel>0</max_vel>
            </ode>
          </contact>
          <friction>
            <ode/>
          </friction>
        </surface>
      </collision>
      
      <visual name="base_link_visual">
        <geometry>
          <box>
            <size>${maverickPhysics.dimensions.x} ${maverickPhysics.dimensions.y} ${maverickPhysics.dimensions.z}</size>
          </box>
        </geometry>
        <material>
          <script>
            <name>Gazebo/DarkGrey</name>
            <uri>file://media/materials/scripts/gazebo.material</uri>
          </script>
        </material>
      </visual>

      <!-- Headless Actuators / Physics properties -->
      <gravity>1</gravity>
      <velocity_decay/>
    </link>

    <!-- Motor 1 (Front Right) -->
    <link name='rotor_0'>
      <pose>${armLength * 0.707} -${armLength * 0.707} 0.05 0 0 0</pose>
      <inertial>
        <mass>0.005</mass>
        <inertia>
          <ixx>9.75e-07</ixx>
          <ixy>0</ixy>
          <ixz>0</ixz>
          <iyy>0.000273104</iyy>
          <iyz>0</iyz>
          <izz>0.000274004</izz>
        </inertia>
      </inertial>
      <visual name='rotor_0_visual'>
        <geometry>
          <cylinder>
            <radius>0.128</radius>
            <length>0.005</length>
          </cylinder>
        </geometry>
        <material>
          <script>
            <name>Gazebo/Blue</name>
            <uri>file://media/materials/scripts/gazebo.material</uri>
          </script>
        </material>
      </visual>
    </link>
    <joint name='rotor_0_joint' type='revolute'>
      <child>rotor_0</child>
      <parent>base_link</parent>
      <axis>
        <xyz>0 0 1</xyz>
        <limit>
          <lower>-1e+16</lower>
          <upper>1e+16</upper>
        </limit>
        <dynamics>
          <spring_reference>0</spring_reference>
          <spring_stiffness>0</spring_stiffness>
        </dynamics>
      </axis>
    </joint>

    <!-- Motor 2 (Back Left) -->
    <link name='rotor_1'>
      <pose>-${armLength * 0.707} ${armLength * 0.707} 0.05 0 0 0</pose>
      <inertial>
        <mass>0.005</mass>
        <inertia>
          <ixx>9.75e-07</ixx>
          <ixy>0</ixy>
          <ixz>0</ixz>
          <iyy>0.000273104</iyy>
          <iyz>0</iyz>
          <izz>0.000274004</izz>
        </inertia>
      </inertial>
      <visual name='rotor_1_visual'>
        <geometry>
          <cylinder>
            <radius>0.128</radius>
            <length>0.005</length>
          </cylinder>
        </geometry>
        <material>
          <script>
            <name>Gazebo/Blue</name>
            <uri>file://media/materials/scripts/gazebo.material</uri>
          </script>
        </material>
      </visual>
    </link>
    <joint name='rotor_1_joint' type='revolute'>
      <child>rotor_1</child>
      <parent>base_link</parent>
      <axis>
        <xyz>0 0 1</xyz>
        <limit>
          <lower>-1e+16</lower>
          <upper>1e+16</upper>
        </limit>
      </axis>
    </joint>

    <!-- Motor 3 (Front Left) -->
    <link name='rotor_2'>
      <pose>${armLength * 0.707} ${armLength * 0.707} 0.05 0 0 0</pose>
      <inertial>
        <mass>0.005</mass>
        <inertia>
          <ixx>9.75e-07</ixx>
          <ixy>0</ixy>
          <ixz>0</ixz>
          <iyy>0.000273104</iyy>
          <iyz>0</iyz>
          <izz>0.000274004</izz>
        </inertia>
      </inertial>
      <visual name='rotor_2_visual'>
        <geometry>
          <cylinder>
            <radius>0.128</radius>
            <length>0.005</length>
          </cylinder>
        </geometry>
        <material>
          <script>
            <name>Gazebo/Blue</name>
            <uri>file://media/materials/scripts/gazebo.material</uri>
          </script>
        </material>
      </visual>
    </link>
    <joint name='rotor_2_joint' type='revolute'>
      <child>rotor_2</child>
      <parent>base_link</parent>
      <axis>
        <xyz>0 0 1</xyz>
        <limit>
          <lower>-1e+16</lower>
          <upper>1e+16</upper>
        </limit>
      </axis>
    </joint>

    <!-- Motor 4 (Back Right) -->
    <link name='rotor_3'>
      <pose>-${armLength * 0.707} -${armLength * 0.707} 0.05 0 0 0</pose>
      <inertial>
        <mass>0.005</mass>
        <inertia>
          <ixx>9.75e-07</ixx>
          <ixy>0</ixy>
          <ixz>0</ixz>
          <iyy>0.000273104</iyy>
          <iyz>0</iyz>
          <izz>0.000274004</izz>
        </inertia>
      </inertial>
      <visual name='rotor_3_visual'>
        <geometry>
          <cylinder>
            <radius>0.128</radius>
            <length>0.005</length>
          </cylinder>
        </geometry>
        <material>
          <script>
            <name>Gazebo/Blue</name>
            <uri>file://media/materials/scripts/gazebo.material</uri>
          </script>
        </material>
      </visual>
    </link>
    <joint name='rotor_3_joint' type='revolute'>
      <child>rotor_3</child>
      <parent>base_link</parent>
      <axis>
        <xyz>0 0 1</xyz>
        <limit>
          <lower>-1e+16</lower>
          <upper>1e+16</upper>
        </limit>
      </axis>
    </joint>

    <!-- Plugins -->
    <plugin name='rosbag' filename='libgazebo_ros_utils.so'>
      <robotNamespace/>
    </plugin>
    
    <!-- Actuator Plugin: Motor Model (Simplified) -->
    <!-- This represents the "headless actuators" logic -->
    <plugin name='front_right_motor_model' filename='libgazebo_motor_model.so'>
      <robotNamespace/>
      <jointName>rotor_0_joint</jointName>
      <linkName>rotor_0</linkName>
      <turningDirection>ccw</turningDirection>
      <timeConstantUp>0.0125</timeConstantUp>
      <timeConstantDown>0.025</timeConstantDown>
      <maxRotVelocity>1100</maxRotVelocity>
      <motorConstant>8.54858e-06</motorConstant>
      <momentConstant>0.06</momentConstant>
      <commandSubTopic>cmd/motor_speed/0</commandSubTopic>
      <motorNumber>0</motorNumber>
      <rotorDragCoefficient>0.000175</rotorDragCoefficient>
      <rollingMomentCoefficient>1e-06</rollingMomentCoefficient>
      <motorSpeedPubTopic>/motor_speed/0</motorSpeedPubTopic>
      <rotorVelocitySlowdownSim>10</rotorVelocitySlowdownSim>
    </plugin>

    <plugin name='back_left_motor_model' filename='libgazebo_motor_model.so'>
      <robotNamespace/>
      <jointName>rotor_1_joint</jointName>
      <linkName>rotor_1</linkName>
      <turningDirection>ccw</turningDirection>
      <timeConstantUp>0.0125</timeConstantUp>
      <timeConstantDown>0.025</timeConstantDown>
      <maxRotVelocity>1100</maxRotVelocity>
      <motorConstant>8.54858e-06</motorConstant>
      <momentConstant>0.06</momentConstant>
      <commandSubTopic>cmd/motor_speed/1</commandSubTopic>
      <motorNumber>1</motorNumber>
      <rotorDragCoefficient>0.000175</rotorDragCoefficient>
      <rollingMomentCoefficient>1e-06</rollingMomentCoefficient>
      <motorSpeedPubTopic>/motor_speed/1</motorSpeedPubTopic>
      <rotorVelocitySlowdownSim>10</rotorVelocitySlowdownSim>
    </plugin>

    <plugin name='front_left_motor_model' filename='libgazebo_motor_model.so'>
      <robotNamespace/>
      <jointName>rotor_2_joint</jointName>
      <linkName>rotor_2</linkName>
      <turningDirection>cw</turningDirection>
      <timeConstantUp>0.0125</timeConstantUp>
      <timeConstantDown>0.025</timeConstantDown>
      <maxRotVelocity>1100</maxRotVelocity>
      <motorConstant>8.54858e-06</motorConstant>
      <momentConstant>0.06</momentConstant>
      <commandSubTopic>cmd/motor_speed/2</commandSubTopic>
      <motorNumber>2</motorNumber>
      <rotorDragCoefficient>0.000175</rotorDragCoefficient>
      <rollingMomentCoefficient>1e-06</rollingMomentCoefficient>
      <motorSpeedPubTopic>/motor_speed/2</motorSpeedPubTopic>
      <rotorVelocitySlowdownSim>10</rotorVelocitySlowdownSim>
    </plugin>

    <plugin name='back_right_motor_model' filename='libgazebo_motor_model.so'>
      <robotNamespace/>
      <jointName>rotor_3_joint</jointName>
      <linkName>rotor_3</linkName>
      <turningDirection>cw</turningDirection>
      <timeConstantUp>0.0125</timeConstantUp>
      <timeConstantDown>0.025</timeConstantDown>
      <maxRotVelocity>1100</maxRotVelocity>
      <motorConstant>8.54858e-06</motorConstant>
      <momentConstant>0.06</momentConstant>
      <commandSubTopic>cmd/motor_speed/3</commandSubTopic>
      <motorNumber>3</motorNumber>
      <rotorDragCoefficient>0.000175</rotorDragCoefficient>
      <rollingMomentCoefficient>1e-06</rollingMomentCoefficient>
      <motorSpeedPubTopic>/motor_speed/3</motorSpeedPubTopic>
      <rotorVelocitySlowdownSim>10</rotorVelocitySlowdownSim>
    </plugin>

  </model>
</sdf>
`
