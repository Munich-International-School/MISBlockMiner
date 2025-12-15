import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { VoxelWorld, createTextureAtlas } from './src/VoxelWorld.js';
import { Player } from './src/Player.js';
import { InputManager } from './src/InputManager.js';

// --- Global Variables ---
let camera, scene, renderer, controls;
let voxelWorld;
let player;
let inputManager;
let prevTime = performance.now();
const cellSize = 32;
const chunks = {};
let currentBlockType = 3;

try {
    init();
    animate();
} catch (e) {
    console.error(e);
    alert("Game Error: " + e.message);
}

function init() {
    // 1. Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // Sky Blue
    scene.fog = new THREE.Fog(0x87CEEB, 10, 60);

    // 2. Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(cellSize / 2, 20, cellSize / 2); // Position is managed by Player, but we set initial

    // 3. Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);

    // 4. Light
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
    hemiLight.position.set(0, 50, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(20, 50, 10);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // 5. Voxel World Setup
    const tileSize = 64;
    const tileTextureWidth = 512;
    const tileTextureHeight = 512;

    voxelWorld = new VoxelWorld({
        cellSize,
        tileSize,
        tileTextureWidth,
        tileTextureHeight,
    });

    // Generate Terrain
    for (let y = 0; y < cellSize; ++y) {
        for (let z = 0; z < cellSize; ++z) {
            for (let x = 0; x < cellSize; ++x) {
                const height = (Math.sin(x / 4) + Math.cos(z / 4)) * 2 + 5; // Simple waves
                if (y < height) {
                    // Decide block type
                    voxelWorld.setVoxel(x, y, z, y < height - 1 ? 1 : 2); // 1=Dirt, 2=Grass
                }
            }
        }
    }

    // Update Mesh
    updateVoxelGeometry(0, 0, 0);

    // 6. Controls & Input
    controls = new PointerLockControls(camera, document.body);

    const instructions = document.getElementById('instructions');
    const ui = document.getElementById('ui');

    instructions.addEventListener('click', function () {
        controls.lock();
    });

    controls.addEventListener('lock', function () {
        instructions.style.display = 'none';
        ui.style.pointerEvents = 'none';
    });

    controls.addEventListener('unlock', function () {
        instructions.style.display = 'block';
        ui.style.pointerEvents = 'auto';
    });

    scene.add(controls.getObject());

    inputManager = new InputManager();
    player = new Player(camera, controls, voxelWorld);

    // ... previous code

    // 8. Interaction Logic
    const onMouseUp = (event) => {
        if (controls.isLocked) {
            const start = new THREE.Vector3();
            const end = new THREE.Vector3();
            start.setFromMatrixPosition(camera.matrixWorld);
            end.set(0, 0, 1).unproject(camera);

            // The logic above for "unproject" with (0,0,1) gives a point on the far plane. 
            // Better to get direction from camera.

            const direction = new THREE.Vector3();
            camera.getWorldDirection(direction);
            end.copy(start).add(direction.multiplyScalar(10)); // 10 units range

            const intersection = voxelWorld.intersectRay(start, end);
            if (intersection) {
                const pos = intersection.position;
                if (event.button === 0) {
                    // Left Click: Mine
                    voxelWorld.setVoxel(pos[0], pos[1], pos[2], 0);
                    updateVoxelGeometry(pos[0], pos[1], pos[2]);
                } else if (event.button === 2) {
                    // Right Click: Place
                    const normal = intersection.normal;
                    const newPos = [pos[0] + normal[0], pos[1] + normal[1], pos[2] + normal[2]];

                    // Don't place inside player
                    const playerPos = new THREE.Vector3();
                    playerPos.copy(controls.getObject().position);
                    // Simple check: is new block intserecting player bbox?
                    // Player radius 0.3, height 1.7. 
                    // Block is 1x1x1 at newPos (integer coords).
                    // Ideally use AABB check. For now, just simplistic distance check to center?
                    // Let's rely on simple box check.

                    // Helper: AABB vs AABB
                    const pBox = new THREE.Box3();
                    pBox.setFromCenterAndSize(
                        new THREE.Vector3(playerPos.x, playerPos.y - 0.85, playerPos.z), // Center of player (eye is at top)
                        new THREE.Vector3(0.6, 1.7, 0.6)
                    );

                    const bBox = new THREE.Box3();
                    bBox.min.set(newPos[0], newPos[1], newPos[2]);
                    bBox.max.set(newPos[0] + 1, newPos[1] + 1, newPos[2] + 1);

                    if (!pBox.intersectsBox(bBox)) {
                        voxelWorld.setVoxel(newPos[0], newPos[1], newPos[2], currentBlockType);
                        updateVoxelGeometry(newPos[0], newPos[1], newPos[2]);
                    }
                }
            }
        }
    };

    document.addEventListener('mouseup', onMouseUp);

    // Resize Handler
    window.addEventListener('resize', onWindowResize);
}

window.addEventListener('keydown', (e) => {
    if (e.key >= '1' && e.key <= '3') {
        currentBlockType = parseInt(e.key);
    }
});


function updateVoxelGeometry(x, y, z) {
    const chunkId = `${x},${y},${z}`;

    // Remove existing chunk mesh
    let chunk = chunks[chunkId];
    if (chunk) {
        scene.remove(chunk);
        chunk.geometry.dispose();
    }

    const { positions, normals, uvs, indices } = voxelWorld.generateGeometryDataForCell(x, y, z);

    // If no geometry (empty chunk), stop here
    if (positions.length === 0) {
        delete chunks[chunkId];
        return;
    }

    const geometry = new THREE.BufferGeometry();
    const material = new THREE.MeshLambertMaterial({
        map: createTextureAtlas(),
        side: THREE.FrontSide,
        alphaTest: 0.1,
        transparent: false,
    });

    const positionNumComponents = 3;
    const normalNumComponents = 3;
    const uvNumComponents = 2;

    geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(positions), positionNumComponents));
    geometry.setAttribute(
        'normal',
        new THREE.BufferAttribute(new Float32Array(normals), normalNumComponents));
    geometry.setAttribute(
        'uv',
        new THREE.BufferAttribute(new Float32Array(uvs), uvNumComponents));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    chunks[chunkId] = mesh;
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    const time = performance.now();
    const delta = (time - prevTime) / 1000;
    prevTime = time;

    player.update(delta, inputManager.state);

    renderer.render(scene, camera);
}
