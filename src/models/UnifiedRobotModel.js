/**
 * Unified robot model data interface
 * All formats (URDF, MJCF, USD) are converted to this unified format
 */
export class UnifiedRobotModel {
    constructor() {
        this.name = '';
        this.links = new Map(); // Map<name, Link>
        this.joints = new Map(); // Map<name, Joint>
        this.materials = new Map(); // Map<name, Material>
        this.constraints = new Map(); // Map<name, Constraint> - for parallel mechanism constraints
        this.sites = new Map(); // Named MJCF frames used by equality constraints
        this.rootLink = null; // Root link name
        this.threeObject = null; // Three.js object (if available)
    }

    addLink(link) {
        this.links.set(link.name, link);
    }

    addJoint(joint) {
        this.joints.set(joint.name, joint);
    }

    addConstraint(constraint) {
        this.constraints.set(constraint.name, constraint);
    }

    getLink(name) {
        return this.links.get(name);
    }

    getJoint(name) {
        return this.joints.get(name);
    }

    getConstraint(name) {
        return this.constraints.get(name);
    }
}

/**
 * Link interface
 */
export class Link {
    constructor(name) {
        this.name = name;
        this.visuals = []; // VisualGeometry[]
        this.collisions = []; // CollisionGeometry[]
        this.inertial = null; // InertialProperties
        this.threeObject = null; // Three.js object
        this.userData = {}; // User-defined data (for adapters to store additional information)
    }
}

/**
 * VisualGeometry interface
 */
export class VisualGeometry {
    constructor() {
        this.name = '';
        this.origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
        this.geometry = null; // GeometryType
        this.material = null; // Material
        this.threeObject = null; // Three.js Mesh
    }
}

/**
 * CollisionGeometry interface
 */
export class CollisionGeometry {
    constructor() {
        this.name = '';
        this.origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
        this.geometry = null; // GeometryType
        this.threeObject = null; // Three.js Mesh
    }
}

/**
 * GeometryType interface
 */
export class GeometryType {
    constructor(type) {
        this.type = type; // 'plane' | 'box' | 'sphere' | 'cylinder' | 'capsule' | 'mesh'
        this.size = null; // Size parameters (varies by type)
        this.filename = null; // Mesh file path (if mesh type)
        this.infinite = false; // Infinite primitives should not define camera framing bounds
    }

    clone() {
        const cloned = new GeometryType(this.type);
        cloned.size = this.size ? { ...this.size } : null;
        cloned.filename = this.filename;
        cloned.infinite = this.infinite;
        return cloned;
    }
}

/**
 * InertialProperties interface
 */
export class InertialProperties {
    constructor() {
        this.mass = 0;
        this.origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
        this.ixx = 0;
        this.iyy = 0;
        this.izz = 0;
        this.ixy = 0;
        this.ixz = 0;
        this.iyz = 0;
    }
}

/**
 * Joint interface
 */
export class Joint {
    constructor(name, type) {
        this.name = name;
        this.type = type; // 'revolute' | 'prismatic' | 'fixed' | 'continuous'
        this.parent = null; // Parent link name
        this.child = null; // Child link name
        this.origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
        this.axis = { xyz: [0, 0, 1] }; // Default z-axis
        this.limits = null; // JointLimits
        this.currentValue = 0; // Current joint value
        this.ref = 0; // MJCF qpos0; spatial displacement is currentValue - ref
        this.stiffness = 0; // Passive MJCF joint spring, if present
        this.threeObject = null; // Three.js object (if available)
    }
}

/** Scalar pose controls cannot represent floating or quaternion joints. */
export function isScalarJoint(joint) {
    return ['revolute', 'continuous', 'prismatic'].includes(joint?.type);
}

// 关节分组：先按部位（头/腰/手/臂/腿），再按左右细分，供关节面板分类展示。
// 匹配按词边界进行，避免 overhead 之类的词误命中 head。
const JOINT_REGION_PATTERNS = [
    ['head', /(?:^|[^a-z])(?:head|neck|skull|jaw)(?:[^a-z]|$)/i],
    ['waist', /(?:^|[^a-z])(?:waist|torso|spine|trunk|abdomen|pelvis)(?:[^a-z]|$)/i],
    ['hand', /(?:^|[^a-z])(?:hand|finger|thumb|index|middle|ring|little|pinky|palm|gripper|claw|manipulator)(?:[^a-z]|$)/i],
    ['arm', /(?:^|[^a-z])(?:shoulder|clavicle|elbow|wrist|forearm|arm|sixforce)(?:[^a-z]|$)/i],
    ['leg', /(?:^|[^a-z])(?:hip|thigh|knee|shin|calf|ankle|foot|feet|toe|leg)(?:[^a-z]|$)/i]
];

const JOINT_LEFT_PATTERN = /(?:^|[^a-z])(?:l|left)(?:[^a-z]|$)/i;
const JOINT_RIGHT_PATTERN = /(?:^|[^a-z])(?:r|right)(?:[^a-z]|$)/i;

// 面板展示顺序：头 → 左右臂 → 左右手 → 腰 → 左右腿 → 其他
export const JOINT_PARTS = [
    'head',
    'leftArm', 'rightArm', 'arm',
    'leftHand', 'rightHand', 'hand',
    'waist',
    'leftLeg', 'rightLeg', 'leg',
    'other'
];

/**
 * 依据关节名推断部位（含左右），供关节面板分类展示。
 * @param {string} jointName
 * @returns {'head'|'waist'|'leftArm'|'rightArm'|'arm'|'leftHand'|'rightHand'|'hand'|'leftLeg'|'rightLeg'|'leg'|'other'}
 */
// 手部被动耦合关节：Inspire RH56 的 *_dip_joint、BrainCo Revo 的 *_distal_joint。
// 它们由主动关节经连杆/mimic 带动，真机没有独立电机，关节面板不展示。
const PASSIVE_HAND_JOINT_PATTERN = /_(?:dip|distal)_joint$/i;

/**
 * 是否为手部被动（无独立驱动）关节。
 * @param {string} jointName
 */
export function isPassiveHandJoint(jointName) {
    return PASSIVE_HAND_JOINT_PATTERN.test(String(jointName || ''));
}

export function classifyJointPart(jointName) {
    const name = String(jointName || '');
    const region = JOINT_REGION_PATTERNS.find(([, pattern]) => pattern.test(name))?.[0];
    if (!region) return 'other';
    if (region === 'head' || region === 'waist') return region;

    const side = JOINT_LEFT_PATTERN.test(name) ? 'left'
        : JOINT_RIGHT_PATTERN.test(name) ? 'right' : null;

    if (region === 'arm') return side ? `${side}Arm` : 'arm';
    if (region === 'hand') return side ? `${side}Hand` : 'hand';
    return side ? `${side}Leg` : 'leg';
}

/**
 * JointLimits interface
 */
export class JointLimits {
    constructor() {
        this.lower = -Math.PI;
        this.upper = Math.PI;
        this.effort = null;
        this.velocity = null;
    }
}

/**
 * Material interface
 */
export class Material {
    constructor(name) {
        this.name = name;
        this.color = { r: 0.8, g: 0.8, b: 0.8 };
        this.texture = null;
    }
}

/**
 * Constraint interface - for describing closed-chain constraints of parallel mechanisms
 * Supports MuJoCo equality constraint types
 */
export class Constraint {
    constructor(name, type) {
        this.name = name;
        this.type = type; // 'connect' | 'weld' | 'joint' | 'tendon' | 'distance'

        // Constraint objects (may be body, geom, joint, etc. depending on type)
        this.body1 = null;
        this.body2 = null;
        this.anchor = null; // Connection point coordinates
        this.torquescale = null; // Torque scale
        this.site1 = null;
        this.site2 = null;
        this.relpose = null;
        this.active = true;

        // Joint constraint specific properties
        this.joint1 = null;
        this.joint2 = null;
        this.polycoef = null; // Polynomial coefficients [a0, a1, a2, a3, a4]

        // Visualization object
        this.threeObject = null; // Three.js object for displaying constraint

        // Original data (for debugging)
        this.userData = {};
    }
}
