import { ObjectId } from 'mongodb';
import { Role } from './roles';

export interface UserDocument {
  _id: ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  branchId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  branchId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthPrincipal {
  sub: string;
  role: Role;
  branchId: string | null;
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user._id.toHexString(),
    name: user.name,
    email: user.email,
    role: user.role,
    branchId: user.branchId,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
