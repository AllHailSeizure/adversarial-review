import { Hono } from 'hono';
import { register } from './adversarial-reviewer';

export function createApp(): Hono {
  const app = new Hono();
  register(app);
  return app;
}
