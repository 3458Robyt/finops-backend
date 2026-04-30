import type { AuthContext } from '../../domain/models/AuthContext.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
