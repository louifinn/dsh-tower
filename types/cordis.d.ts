// Ambient augmentation for the Tower mode service (#50).
declare module '@deepseek-ai/cordis' {
  interface Context {
    tower?: import('./index.js').ModeStateService
  }
}
