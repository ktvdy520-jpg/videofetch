declare module 'mux.js' {
  const muxjs: {
    mp4: {
      Transmuxer: new (options?: { keepOriginalTimestamps?: boolean }) => {
        on(event: 'data' | 'done' | 'error', cb: (data: unknown) => void): void;
        push(data: ArrayBuffer): void;
        flush(): void;
        dispose?: () => void;
      };
    };
  };
  export default muxjs;
}
