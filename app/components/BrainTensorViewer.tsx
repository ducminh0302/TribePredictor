"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import styles from "../page.module.css";

type Props = {
  npyUrl: string;
  meshUrl?: string | null;
};

type NpyData = {
  shape: number[];
  data: Float32Array;
};

type MeshJsonPayload = {
  format: string;
  left: { coords: number[][]; faces: number[][] };
  right: { coords: number[][]; faces: number[][] };
};

type HemisphereBuffers = {
  mesh: THREE.Mesh;
  colors: Float32Array;
  colorAttribute: THREE.BufferAttribute;
};

const BASE_COLOR = { r: 0.76, g: 0.78, b: 0.82 };
const LOW_PERCENTILE = 0.8;
const HIGH_PERCENTILE = 0.995;

function parseNpyFloat32(buffer: ArrayBuffer): NpyData {
  const magic = new Uint8Array(buffer, 0, 6);
  const magicText = String.fromCharCode(...magic);
  if (magicText !== "\x93NUMPY") {
    throw new Error("Invalid NPY file signature");
  }

  const view = new DataView(buffer);
  const major = view.getUint8(6);

  let headerLength = 0;
  let headerOffset = 0;

  if (major === 1 || major === 2) {
    headerLength = view.getUint16(8, true);
    headerOffset = 10;
  } else if (major === 3) {
    headerLength = view.getUint32(8, true);
    headerOffset = 12;
  } else {
    throw new Error(`Unsupported NPY major version: ${major}`);
  }

  const headerBytes = new Uint8Array(buffer, headerOffset, headerLength);
  const header = new TextDecoder("ascii").decode(headerBytes);

  if (!header.includes("'descr': '<f4'") && !header.includes('"descr": "<f4"')) {
    throw new Error("Only float32 little-endian NPY tensors are supported");
  }

  const shapeMatch = header.match(/\(([^)]*)\)/);
  if (!shapeMatch) {
    throw new Error("Unable to parse tensor shape from NPY header");
  }

  const shape = shapeMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10));

  if (shape.length < 2 || shape.some((v) => Number.isNaN(v) || v <= 0)) {
    throw new Error("Unsupported tensor shape");
  }

  const dataOffset = headerOffset + headerLength;
  const data = new Float32Array(buffer, dataOffset);
  return { shape, data };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function heatRamp(t: number) {
  const v = clamp(t, 0, 1);
  if (v < 0.35) {
    const k = v / 0.35;
    return {
      r: 0.35 + k * 0.5,
      g: 0.06 + k * 0.15,
      b: 0.08 + k * 0.08,
    };
  }

  if (v < 0.75) {
    const k = (v - 0.35) / 0.4;
    return {
      r: 0.85 + k * 0.13,
      g: 0.21 + k * 0.43,
      b: 0.16 - k * 0.04,
    };
  }

  const k = (v - 0.75) / 0.25;
  return {
    r: 0.98 + k * 0.02,
    g: 0.64 + k * 0.33,
    b: 0.12 + k * 0.68,
  };
}

function percentileFromSorted(sorted: Float32Array, p: number) {
  if (sorted.length === 0) {
    return 0;
  }

  const idx = Math.floor(clamp(p, 0, 1) * (sorted.length - 1));
  return sorted[idx];
}

function buildHemisphereFromMeshData(coords: number[][], faces: number[][]): HemisphereBuffers {
  const geometry = new THREE.BufferGeometry();

  const positionArray = new Float32Array(coords.length * 3);
  for (let i = 0; i < coords.length; i += 1) {
    const base = i * 3;
    positionArray[base] = coords[i][0];
    positionArray[base + 1] = coords[i][1];
    positionArray[base + 2] = coords[i][2];
  }

  const indexArray = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i += 1) {
    const base = i * 3;
    indexArray[base] = faces[i][0];
    indexArray[base + 1] = faces[i][1];
    indexArray[base + 2] = faces[i][2];
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positionArray, 3));
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geometry.computeVertexNormals();

  const colors = new Float32Array(coords.length * 3);
  for (let i = 0; i < coords.length; i += 1) {
    const ci = i * 3;
    colors[ci] = BASE_COLOR.r;
    colors[ci + 1] = BASE_COLOR.g;
    colors[ci + 2] = BASE_COLOR.b;
  }

  const colorAttribute = new THREE.BufferAttribute(colors, 3);
  geometry.setAttribute("color", colorAttribute);

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.03,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  return { mesh, colors, colorAttribute };
}

function paintHemisphere(params: {
  frameOffset: number;
  sourceOffset: number;
  sourceCount: number;
  tensor: Float32Array;
  lowAbs: number;
  highAbs: number;
  hemisphere: HemisphereBuffers;
}) {
  const { frameOffset, sourceOffset, sourceCount, tensor, lowAbs, highAbs, hemisphere } = params;

  const span = Math.max(highAbs - lowAbs, 1e-6);

  for (let i = 0; i < sourceCount; i += 1) {
    const value = tensor[frameOffset + sourceOffset + i];
    const normalized = clamp((Math.abs(value) - lowAbs) / span, 0, 1);

    const heat = heatRamp(normalized);
    const activity = clamp(Math.pow(normalized, 0.58) * 1.35, 0, 1);

    const ci = i * 3;
    hemisphere.colors[ci] = BASE_COLOR.r * (1 - activity) + heat.r * activity;
    hemisphere.colors[ci + 1] = BASE_COLOR.g * (1 - activity) + heat.g * activity;
    hemisphere.colors[ci + 2] = BASE_COLOR.b * (1 - activity) + heat.b * activity;
  }

  hemisphere.colorAttribute.needsUpdate = true;
}

function paintFrame(params: {
  frame: number;
  tensor: Float32Array;
  shape: number[];
  left: HemisphereBuffers;
  right: HemisphereBuffers;
}) {
  const { frame, tensor, shape, left, right } = params;

  const t = shape[0];
  const v = shape[1];
  if (frame < 0 || frame >= t || v < 2) {
    return;
  }

  const frameOffset = frame * v;
  const absValues = new Float32Array(v);
  for (let i = 0; i < v; i += 1) {
    absValues[i] = Math.abs(tensor[frameOffset + i]);
  }

  absValues.sort();
  const lowAbs = percentileFromSorted(absValues, LOW_PERCENTILE);
  const p95 = percentileFromSorted(absValues, 0.95);
  const pHigh = percentileFromSorted(absValues, HIGH_PERCENTILE);
  const highAbs = Math.max(pHigh, p95 + 1e-6);
  const half = Math.floor(v / 2);

  paintHemisphere({
    frameOffset,
    sourceOffset: 0,
    sourceCount: half,
    tensor,
    lowAbs,
    highAbs,
    hemisphere: left,
  });

  paintHemisphere({
    frameOffset,
    sourceOffset: half,
    sourceCount: v - half,
    tensor,
    lowAbs,
    highAbs,
    hemisphere: right,
  });
}

export default function BrainTensorViewer({ npyUrl, meshUrl }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const leftRef = useRef<HemisphereBuffers | null>(null);
  const rightRef = useRef<HemisphereBuffers | null>(null);
  const rafRef = useRef<number | null>(null);

  const [tensor, setTensor] = useState<Float32Array | null>(null);
  const [shape, setShape] = useState<number[] | null>(null);
  const [meshPayload, setMeshPayload] = useState<MeshJsonPayload | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const frameCount = shape?.[0] ?? 0;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setError(null);
        setTensor(null);
        setShape(null);
        setMeshPayload(null);
        setFrame(0);
        setPlaying(false);

        const tensorResponse = await fetch(npyUrl, { cache: "no-store" });
        if (!tensorResponse.ok) {
          throw new Error("Unable to download predictions tensor");
        }

        const tensorBuffer = await tensorResponse.arrayBuffer();
        if (cancelled) {
          return;
        }

        const parsedTensor = parseNpyFloat32(tensorBuffer);
        setShape([parsedTensor.shape[0], parsedTensor.shape[1]]);
        setTensor(parsedTensor.data);

        if (meshUrl) {
          const meshResponse = await fetch(meshUrl, { cache: "no-store" });
          if (meshResponse.ok) {
            const payload = (await meshResponse.json()) as MeshJsonPayload;
            if (!cancelled && payload?.left?.coords && payload?.right?.coords) {
              setMeshPayload(payload);
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to parse tensor file";
        if (!cancelled) {
          setError(message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [npyUrl, meshUrl]);

  useEffect(() => {
    if (!stageRef.current || !tensor || !shape) {
      return;
    }

    const stage = stageRef.current;
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0d1220");

    const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
    camera.position.set(0, 0.05, 5.1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;

    const half = Math.floor(shape[1] / 2);

    let left: HemisphereBuffers;
    let right: HemisphereBuffers;

    if (
      meshPayload &&
      meshPayload.format === "fsaverage5" &&
      meshPayload.left.coords.length === half &&
      meshPayload.right.coords.length === shape[1] - half
    ) {
      left = buildHemisphereFromMeshData(meshPayload.left.coords, meshPayload.left.faces);
      right = buildHemisphereFromMeshData(meshPayload.right.coords, meshPayload.right.faces);
    } else {
      return;
    }

    const cortexGroup = new THREE.Group();
    cortexGroup.add(left.mesh);
    cortexGroup.add(right.mesh);
    scene.add(cortexGroup);

    const fitBox = new THREE.Box3().setFromObject(cortexGroup);
    const fitCenter = new THREE.Vector3();
    fitBox.getCenter(fitCenter);
    const fitSize = new THREE.Vector3();
    fitBox.getSize(fitSize);
    const maxDim = Math.max(fitSize.x, fitSize.y, fitSize.z, 1e-6);
    const targetSpan = 2.5;
    const scale = targetSpan / maxDim;

    cortexGroup.scale.setScalar(scale);
    cortexGroup.position.set(-fitCenter.x * scale, -fitCenter.y * scale, -fitCenter.z * scale);

    const fittedBox = new THREE.Box3().setFromObject(cortexGroup);
    const fittedSphere = new THREE.Sphere();
    fittedBox.getBoundingSphere(fittedSphere);

    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const fitDistanceV = fittedSphere.radius / Math.tan(verticalFov / 2);
    const fitDistanceH = fittedSphere.radius / Math.tan(horizontalFov / 2);
    const fitDistance = Math.max(fitDistanceV, fitDistanceH) * 1.2;

    camera.position.set(
      fittedSphere.center.x,
      fittedSphere.center.y + fittedSphere.radius * 0.06,
      fittedSphere.center.z + fitDistance
    );
    camera.near = Math.max(0.01, fitDistance / 200);
    camera.far = Math.max(100, fitDistance * 30);
    camera.updateProjectionMatrix();

    controls.target.copy(fittedSphere.center);
    controls.minDistance = Math.max(0.3, fittedSphere.radius * 0.3);
    controls.maxDistance = Math.max(8, fittedSphere.radius * 12);

    paintFrame({
      frame: 0,
      tensor,
      shape,
      left,
      right,
    });

    const ambient = new THREE.AmbientLight(0xffffff, 0.62);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 0.88);
    key.position.set(2.8, 3.2, 4.2);
    scene.add(key);

    const rim = new THREE.DirectionalLight(0x60a5fa, 0.34);
    rim.position.set(-3.5, 1.2, -3.0);
    scene.add(rim);

    rendererRef.current = renderer;
    cameraRef.current = camera;
    controlsRef.current = controls;
    leftRef.current = left;
    rightRef.current = right;

    const renderLoop = () => {
      controls.update();
      renderer.render(scene, camera);
      rafRef.current = requestAnimationFrame(renderLoop);
    };

    renderLoop();

    const onResize = () => {
      if (!stageRef.current || !rendererRef.current || !cameraRef.current) {
        return;
      }

      const w = Math.max(1, stageRef.current.clientWidth);
      const h = Math.max(1, stageRef.current.clientHeight);
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);

      if (controlsRef.current) {
        controlsRef.current.update();
      }
    };

    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);

      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }

      controls.dispose();
      left.mesh.geometry.dispose();
      right.mesh.geometry.dispose();
      (left.mesh.material as THREE.Material).dispose();
      (right.mesh.material as THREE.Material).dispose();
      renderer.dispose();

      if (renderer.domElement.parentElement === stage) {
        stage.removeChild(renderer.domElement);
      }

      rendererRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      leftRef.current = null;
      rightRef.current = null;
      rafRef.current = null;
    };
  }, [tensor, shape, meshPayload]);

  useEffect(() => {
    if (!tensor || !shape || !leftRef.current || !rightRef.current) {
      return;
    }

    paintFrame({
      frame,
      tensor,
      shape,
      left: leftRef.current,
      right: rightRef.current,
    });
  }, [frame, tensor, shape]);

  useEffect(() => {
    if (!playing || frameCount <= 1) {
      return;
    }

    const timer = window.setInterval(() => {
      setFrame((prev) => (prev + 1) % frameCount);
    }, 220);

    return () => window.clearInterval(timer);
  }, [playing, frameCount]);

  if (error) {
    return <div className={styles.viewerNotice}>3D render error: {error}</div>;
  }

  if (!tensor || !shape) {
    return <div className={styles.viewerNotice}>Preparing interactive 3D brain model...</div>;
  }

  if (!meshPayload) {
    return <div className={styles.viewerNotice}>Waiting for cortical mesh artifact (fsaverage5) to render 3D brain.</div>;
  }

  return (
    <div className={styles.viewerWrap}>
      <div className={styles.viewerLegend}>
        <span>Low</span>
        <div className={styles.viewerLegendBar} />
        <span>High</span>
      </div>
      <div className={styles.viewerStage} ref={stageRef} />
      <div className={styles.viewerControls}>
        <button type="button" onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(frameCount - 1, 0)}
          value={frame}
          onChange={(event) => setFrame(Number.parseInt(event.target.value, 10) || 0)}
        />
        <span>
          t {frame + 1}/{frameCount}
        </span>
      </div>
    </div>
  );
}
