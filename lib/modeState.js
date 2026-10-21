// Owned mode state instead of a bare module-level Map.
export class ModeState {
  constructor(entries) {
    this.map = new Map(entries ?? [])
  }

  has(key) {
    return this.map.has(key)
  }

  get(key) {
    return this.map.get(key)
  }

  set(key, value) {
    this.map.set(key, value)
    return this
  }

  delete(key) {
    return this.map.delete(key)
  }

  values() {
    return this.map.values()
  }

  entries() {
    return this.map.entries()
  }

  replace(entries) {
    this.map = new Map(entries ?? [])
  }

  clear() {
    this.map.clear()
  }
}
