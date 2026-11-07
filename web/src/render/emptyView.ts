import { Color, PerspectiveCamera, Scene } from 'three';
import type { WebGLRenderer } from 'three';
import type { StageView } from './stage';

/** A black room with a camera in it: the stage running with nothing to draw. */
export function createEmptyView(renderer: WebGLRenderer): StageView {
  const scene = new Scene();
  scene.background = new Color(0x000000);
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);

  return {
    resize({ width, height }) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    frame() {
      renderer.render(scene, camera);
    },
    dispose() {},
  };
}
