// Store port (#56). Implementation: adapters/store-fs.js.
/**
 * @typedef {object} StorePort
 * @property {(file: string) => Promise<boolean>} exists
 * @property {(dir: string) => Promise<void>} ensureDir
 * @property {(file: string) => Promise<any>} readJson
 * @property {(file: string, value: unknown) => Promise<void>} writeJsonAtomic
 * @property {(file: string, value: unknown) => Promise<void>} appendJsonl
 * @property {(paths: object, fn: () => Promise<any>, options?: object) => Promise<any>} withLock
 */
export {}
