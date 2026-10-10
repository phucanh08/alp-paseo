declare module 'alp:templates' {
  const templates: Record<string, string>;
  export default templates;
}

declare module 'alp:web' {
  const assets: Record<string, { type: string; body: string }>;
  export default assets;
}
