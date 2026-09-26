/** Font files bundled by the `Data` rule in wrangler.jsonc — raw bytes. */
declare module '*.ttf' {
  const data: ArrayBuffer;
  export default data;
}

/** wrangler compiles an imported .wasm file into a module ready to instantiate. */
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
