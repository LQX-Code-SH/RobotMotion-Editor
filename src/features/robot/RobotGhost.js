import * as THREE from 'three';

/**
 * 真机姿态幽灵层：用半透明镜像模型显示真机**实际**关节角。
 *
 * 视口主模型在「真机同步控制」开启时代表的是下发目标，幽灵层补上真实状态，
 * 两者的差异即跟踪误差，便于判断真机是否跟上。
 */

const GHOST_COLOR = 0x0A84FF;
const GHOST_OPACITY = 0.22;

/** 由当前关节位姿反推「零位」基准（各格式的 ref 已在 displacement 中扣除）。 */
export function computeJointGhostBase({ type, quaternion, position, axis, displacement }) {
    const baseQuaternion = new THREE.Quaternion();
    const basePosition = new THREE.Vector3();

    if (type === 'prismatic') {
        baseQuaternion.copy(quaternion);
        basePosition.copy(position).addScaledVector(axis, -displacement);
    } else {
        baseQuaternion.copy(quaternion)
            .multiply(new THREE.Quaternion().setFromAxisAngle(axis, -displacement));
        basePosition.copy(position);
    }
    return { baseQuaternion, basePosition };
}

/** 按关节位移生成幽灵节点的位姿。 */
export function applyJointGhost({
    type,
    baseQuaternion,
    basePosition,
    axis,
    displacement,
    outQuaternion,
    outPosition
}) {
    if (type === 'prismatic') {
        outQuaternion.copy(baseQuaternion);
        outPosition.copy(basePosition).addScaledVector(axis, displacement);
    } else {
        outQuaternion.copy(baseQuaternion)
            .multiply(new THREE.Quaternion().setFromAxisAngle(axis, displacement));
        outPosition.copy(basePosition);
    }
}

function jointAxisOf(joint) {
    const axis = joint?.threeObject?.axis;
    if (axis instanceof THREE.Vector3) return axis.clone().normalize();
    const xyz = joint?.axis?.xyz;
    if (Array.isArray(xyz)) return new THREE.Vector3(Number(xyz[0]) || 0, Number(xyz[1]) || 0, Number(xyz[2]) || 0)
        .normalize();
    return new THREE.Vector3(0, 0, 1);
}

export class RobotGhost {
    constructor({ sceneManager } = {}) {
        this.sceneManager = sceneManager;
        this.model = null;
        this.root = null;
        this.material = null;
        this.joints = new Map();     // jointName -> 镜像信息
        this.nodeByName = new Map();
        this.visible = true;
        this.hasPose = false;
        this.pose = null;
        this._meshCount = 0;
    }

    setVisible(visible) {
        this.visible = Boolean(visible);
        if (this.root) this.root.visible = this.visible && this.hasPose;
        this.sceneManager?.redraw();
    }

    setModel(model) {
        this._disposeRoot();
        this.model = model || null;
        this.hasPose = false;
        this.pose = null;
        if (!model?.threeObject) return;
        this._build(model);
    }

    /** 用真机 jointStates 驱动幽灵层。 */
    setPose(jointStates) {
        if (!this.model || !jointStates) return;
        // 模型网格可能晚于 onModelLoaded 才挂到场景（URDFLoader 异步贴图/装配），
        // 首次收到遥测时若镜像还是空壳则重建一次
        if (!this.root || this._meshCount === 0) this._rebuildIfModelReady();
        if (!this.root) return;
        this.pose = jointStates;

        let applied = 0;
        this.joints.forEach((mirror, jointName) => {
            const value = jointStates[jointName]?.position;
            if (typeof value !== 'number' || !Number.isFinite(value)) return;
            applyJointGhost({
                type: mirror.type,
                baseQuaternion: mirror.baseQuaternion,
                basePosition: mirror.basePosition,
                axis: mirror.axis,
                displacement: value - mirror.ref,
                outQuaternion: mirror.node.quaternion,
                outPosition: mirror.node.position
            });
            applied += 1;
        });

        if (!applied) return;
        this.hasPose = true;
        this._syncRootTransform();
        this.root.visible = this.visible;
        this.root.updateMatrixWorld(true);
        this.sceneManager?.redraw();
    }

    /** 模型朝向/上轴变化后重新对齐根变换。 */
    refresh() {
        this._syncRootTransform();
        this.root?.updateMatrixWorld(true);
        this.sceneManager?.redraw();
    }

    /** 断开连接时隐藏幽灵层。 */
    clear() {
        this.hasPose = false;
        this.pose = null;
        if (this.root) this.root.visible = false;
        this.sceneManager?.redraw();
    }

    dispose() {
        this._disposeRoot();
        this.model = null;
    }

    // ---------- 内部 ----------

    _build(model) {
        const material = new THREE.MeshBasicMaterial({
            color: GHOST_COLOR,
            transparent: true,
            opacity: GHOST_OPACITY,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        this.material = material;

        const root = new THREE.Object3D();
        root.name = 'RobotGhost';
        root.userData.isVisualization = true;
        root.visible = false;

        this.nodeByName.clear();
        this.joints.clear();

        const sourceRoot = model.threeObject;
        this._mirrorNode(sourceRoot, root, material);
        this._meshCount = 0;
        root.traverse((node) => { if (node.isMesh) this._meshCount += 1; });

        const parent = sourceRoot.parent;
        (parent || this.sceneManager?.scene || new THREE.Scene()).add(root);
        this.root = root;
        this._syncRootTransform();

        // 收集可动关节的零位基准
        model.joints?.forEach((joint) => {
            if (!joint?.threeObject || !['revolute', 'continuous', 'prismatic'].includes(joint.type)) return;
            const node = this.nodeByName.get(joint.threeObject.name);
            if (!node) return;
            const axis = jointAxisOf(joint);
            const ref = Number(joint.ref) || 0;
            const displacement = (Number(joint.currentValue) || 0) - ref;
            const base = computeJointGhostBase({
                type: joint.type,
                quaternion: node.quaternion,
                position: node.position,
                axis,
                displacement
            });
            this.joints.set(joint.name, {
                node,
                type: joint.type,
                axis,
                ref,
                baseQuaternion: base.baseQuaternion,
                basePosition: base.basePosition
            });
        });
    }

    _mirrorNode(source, parentMirror, material) {
        // 跳过可视化辅助对象（坐标轴/关节轴箭头）
        if (source.userData?.isVisualization) return null;
        // 跳过碰撞体：碰撞盒尺寸远大于外观，混进幽灵层会变成大片色块
        if (source.isURDFCollider || source.userData?.isCollision || source.userData?.isCollisionGeom) return null;

        let mirror;
        if (source.isMesh && source.geometry) {
            mirror = new THREE.Mesh(source.geometry, material);
            mirror.matrixAutoUpdate = true;
        } else {
            mirror = new THREE.Object3D();
        }

        mirror.name = source.name || '';
        mirror.position.copy(source.position);
        mirror.quaternion.copy(source.quaternion);
        mirror.scale.copy(source.scale);
        mirror.visible = source.visible !== false;
        mirror.userData.isVisualization = true;
        parentMirror.add(mirror);

        if (mirror.name && !this.nodeByName.has(mirror.name)) {
            this.nodeByName.set(mirror.name, mirror);
        }

        if (!source.isMesh) {
            source.children.forEach((child) => this._mirrorNode(child, mirror, material));
        }
        return mirror;
    }

    _rebuildIfModelReady() {
        if (!this.model?.threeObject) return;
        let meshCount = 0;
        this.model.threeObject.traverse((node) => { if (node.isMesh) meshCount += 1; });
        if (!meshCount) return;
        this.setModel(this.model);
    }

    _syncRootTransform() {
        if (!this.root || !this.model?.threeObject) return;
        const source = this.model.threeObject;
        this.root.position.copy(source.position);
        this.root.quaternion.copy(source.quaternion);
        this.root.scale.copy(source.scale);
    }

    _disposeRoot() {
        if (this.root) {
            this.root.parent?.remove(this.root);
        }
        this.root = null;
        this.nodeByName.clear();
        this.joints.clear();
        this.hasPose = false;
        this.pose = null;
        if (this.material) {
            this.material.dispose();
            this.material = null;
        }
    }
}
