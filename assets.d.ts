// `bb plugin build` bundles the import; tsc only needs to know it is a module
// with no types of its own. TypeScript 6 rejects a side-effect import of an
// unknown path without this.
declare module "*.css";
