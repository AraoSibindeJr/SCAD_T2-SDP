import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { DomainError } from './twoPhase.js';
import type { Region } from './db.js';

export type Role = 'admin' | 'buyer';
export type SessionUser = { id: string; displayName: string; role: Role; region: Region | null };
export type AuthenticatedRequest = Request & { user?: SessionUser };

const secret = process.env.SCAD_AUTH_SECRET || '';
if (secret.length < 24) throw new Error('SCAD_AUTH_SECRET must have at least 24 characters');
const accounts: Array<SessionUser & { password: string }> = [
  { id: 'admin', displayName: 'Administrador SCAD', role: 'admin', region: null, password: process.env.SCAD_ADMIN_PASSWORD || '' },
  { id: 'buyer-south', displayName: 'Comprador · Maputo', role: 'buyer', region: 'south', password: process.env.SCAD_BUYER_SOUTH_PASSWORD || '' },
  { id: 'buyer-center', displayName: 'Comprador · Beira', role: 'buyer', region: 'center', password: process.env.SCAD_BUYER_CENTER_PASSWORD || '' },
  { id: 'buyer-north', displayName: 'Comprador · Nampula', role: 'buyer', region: 'north', password: process.env.SCAD_BUYER_NORTH_PASSWORD || '' },
];
if (accounts.some(a => a.password.length < 8)) throw new Error('All SCAD account passwords must have at least 8 characters');
function publicUser(user: SessionUser): SessionUser {
  return { id:user.id, displayName:user.displayName, role:user.role, region:user.region };
}
function equal(a: string, b: string): boolean {
  const x = createHmac('sha256', secret).update(a).digest();
  const y = createHmac('sha256', secret).update(b).digest();
  return timingSafeEqual(x, y);
}
const encode = (raw: unknown) => Buffer.from(JSON.stringify(raw)).toString('base64url');
const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');
export function login(id: string, password: string): { token: string; user: SessionUser } {
  const acct = accounts.find(a=>a.id === id);
  if (!acct || !equal(password, acct.password)) throw new DomainError('Credenciais inválidas', 401);
  const issued = Math.floor(Date.now()/1000);
  const payload = encode({ sub:acct.id, iat:issued, exp:issued + 8*3600, jti: randomUUID() });
  return { token:`${payload}.${sign(payload)}`, user:publicUser(acct) };
}
function resolveToken(token: string): SessionUser {
  if (token.length > 4096) throw new DomainError('Sessão inválida', 401);
  const pieces = token.split('.');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1] || !equal(pieces[1], sign(pieces[0]))) {
    throw new DomainError('Sessão inválida', 401);
  }
  try {
    const data = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8')) as {sub?:string;exp?:number};
    const user = accounts.find(u=>u.id===data.sub);
    if (!user || !data.exp || data.exp <= Date.now()/1000) throw new Error('Expired');
    return publicUser(user);
  } catch { throw new DomainError('Sessão expirada ou inválida', 401); }
}
export const authenticate: RequestHandler = (req,res,next) => {
  try {
    const bearer = req.get('authorization') || '';
    if (!bearer.startsWith('Bearer ')) throw new DomainError('Autenticação obrigatória', 401);
    (req as AuthenticatedRequest).user = resolveToken(bearer.slice(7));
    next();
  } catch (err) { next(err); }
};
export const adminOnly: RequestHandler = (req,_res,next) => {
  const user = (req as AuthenticatedRequest).user;
  if (!user || user.role !== 'admin') return next(new DomainError('Acesso reservado ao administrador', 403));
  next();
};
export function currentUser(req: Request): SessionUser {
  const user = (req as AuthenticatedRequest).user;
  if (!user) throw new DomainError('Autenticação obrigatória', 401);
  return user;
}
export function enforceRegion(user: SessionUser, region: Region): void {
  if (user.role === 'buyer' && user.region !== region) throw new DomainError('Este armazém não pertence ao comprador', 403);
}
export function validateAgentSecret(req: Request): void {
  const configured = process.env.SCAD_AGENT_SECRET || '';
  if (configured.length < 20 || !equal(req.get('x-scad-agent-secret') || '', configured)) throw new DomainError('Agente não autorizado', 401);
}
