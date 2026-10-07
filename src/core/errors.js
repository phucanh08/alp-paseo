export class AlpError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'AlpError';
    this.code = code;
  }
}
