declare module "gif-encoder-2" {
  export default class GIFEncoder {
    constructor(width: number, height: number, algorithm?: string, useOptimizer?: boolean, totalFrames?: number);
    start(): void;
    setDelay(ms: number): void;
    setRepeat(iter: number): void;
    setQuality(quality: number): void;
    setThreshold(threshold: number): void;
    addFrame(ctxOrBuffer: any): void;
    finish(): void;
    out: {
      getData(): Buffer;
    };
  }
}
