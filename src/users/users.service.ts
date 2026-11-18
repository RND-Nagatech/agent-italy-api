import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Document, ObjectId } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { Role } from './roles';
import { PublicUser, UserDocument, toPublicUser } from './user.types';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';

@Injectable()
export class UsersService {
  constructor(private readonly mongo: MongoService) {}

  private get users() {
    return this.mongo.db.collection<UserDocument>('users');
  }

  private get sessions() {
    return this.mongo.db.collection('auth_sessions');
  }

  async list(query: ListUsersQueryDto): Promise<{
    items: PublicUser[];
    nextCursor: string | null;
  }> {
    const filter: Document = query.cursor ? { _id: { $lt: new ObjectId(query.cursor) } } : {};
    const search = query.search?.trim();
    if (search) {
      const slash = String.fromCharCode(92);
      const escapedSearch = [...search]
        .map((character) => '.^$*+?()[]{}|'.includes(character) || character === slash ? slash + character : character)
        .join('');
      const expression = new RegExp(escapedSearch, 'i');
      filter.$or = [
        { name: expression },
        { email: expression },
        { branchId: expression },
      ];
    }
    const results = await this.users
      .find(filter)
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .toArray();
    const hasMore = results.length > query.limit;
    const page = hasMore ? results.slice(0, query.limit) : results;

    return {
      items: page.map(toPublicUser),
      nextCursor: hasMore ? page[page.length - 1]._id.toHexString() : null,
    };
  }

  async create(dto: CreateUserDto): Promise<PublicUser> {
    if (dto.role === Role.Branch && !dto.branchId?.trim()) {
      throw new ConflictException('branchId is required for cabang accounts');
    }
    if (dto.role !== Role.Branch && dto.branchId) {
      throw new ConflictException('branchId is only allowed for cabang accounts');
    }

    const now = new Date();
    const user: UserDocument = {
      _id: new ObjectId(),
      name: dto.name.trim(),
      email: dto.email.trim().toLowerCase(),
      passwordHash: await argon2.hash(dto.password, argonOptions),
      role: dto.role,
      branchId: dto.role === Role.Branch ? dto.branchId!.trim() : null,
      active: true,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.users.insertOne(user);
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ConflictException('Email address is already in use');
      }
      throw error;
    }
    return toPublicUser(user);
  }

  async update(id: string, dto: UpdateUserDto, actorId: string): Promise<PublicUser> {
    const userId = parseObjectId(id);
    const existing = await this.findById(userId);
    const role = dto.role ?? existing.role;
    const name = dto.name?.trim() ?? existing.name;
    const email = dto.email?.trim().toLowerCase() ?? existing.email;

    if (name.length < 2) throw new ConflictException('Name must contain at least 2 characters');
    if (userId.toHexString() === actorId && role !== Role.Admin) {
      throw new ConflictException('You cannot remove admin access from your own account');
    }

    let branchId: string | null = null;
    if (role === Role.Branch) {
      branchId = (dto.branchId === undefined ? existing.branchId : dto.branchId.trim()) || null;
      if (!branchId) throw new ConflictException('branchId is required for cabang accounts');
    } else if (dto.branchId?.trim()) {
      throw new ConflictException('branchId is only allowed for cabang accounts');
    }

    if (existing.role === Role.Admin && existing.active && role !== Role.Admin) {
      await this.ensureAnotherActiveAdmin(userId);
    }

    const updatedAt = new Date();
    let result: UserDocument | null;
    try {
      result = await this.users.findOneAndUpdate(
        { _id: userId },
        { $set: { name, email, role, branchId, updatedAt } },
        { returnDocument: 'after' },
      );
    } catch (error) {
      if (isDuplicateKey(error)) throw new ConflictException('Email address is already in use');
      throw error;
    }
    if (!result) throw new NotFoundException('User not found');

    if (existing.role !== role || existing.branchId !== branchId) {
      await this.revokeSessions(userId, updatedAt);
    }
    return toPublicUser(result);
  }

  async remove(id: string, actorId: string): Promise<void> {
    const userId = parseObjectId(id);
    if (userId.toHexString() === actorId) {
      throw new ConflictException('You cannot delete your own account');
    }

    const existing = await this.findById(userId);
    if (existing.role === Role.Admin && existing.active) {
      await this.ensureAnotherActiveAdmin(userId);
    }

    const deletedAt = new Date();
    await this.revokeSessions(userId, deletedAt);
    const result = await this.users.deleteOne({ _id: userId });
    if (result.deletedCount !== 1) throw new NotFoundException('User not found');
  }

  async updateRole(id: string, dto: UpdateUserRoleDto): Promise<PublicUser> {
    const userId = parseObjectId(id);
    const existing = await this.findById(userId);
    if (dto.role === Role.Branch && !(dto.branchId?.trim() || existing.branchId)) {
      throw new ConflictException('branchId is required for cabang accounts');
    }
    if (dto.role !== Role.Branch && dto.branchId) {
      throw new ConflictException('branchId is only allowed for cabang accounts');
    }

    if (existing.role === Role.Admin && existing.active && dto.role !== Role.Admin) {
      await this.ensureAnotherActiveAdmin(userId);
    }

    const updatedAt = new Date();
    const branchId = dto.role === Role.Branch
      ? (dto.branchId?.trim() || existing.branchId)
      : null;
    const result = await this.users.findOneAndUpdate(
      { _id: userId },
      { $set: { role: dto.role, branchId, updatedAt } },
      { returnDocument: 'after' },
    );
    if (!result) throw new NotFoundException('User not found');
    await this.revokeSessions(userId, updatedAt);
    return toPublicUser(result);
  }

  async updateStatus(id: string, active: boolean, actorId: string): Promise<PublicUser> {
    const userId = parseObjectId(id);
    if (!active && userId.toHexString() === actorId) {
      throw new ConflictException('You cannot deactivate your own account');
    }

    const existing = await this.findById(userId);
    if (!active && existing.role === Role.Admin && existing.active) {
      await this.ensureAnotherActiveAdmin(userId);
    }

    const updatedAt = new Date();
    const result = await this.users.findOneAndUpdate(
      { _id: userId },
      { $set: { active, updatedAt } },
      { returnDocument: 'after' },
    );
    if (!result) throw new NotFoundException('User not found');
    if (!active) await this.revokeSessions(userId, updatedAt);
    return toPublicUser(result);
  }

  private async findById(userId: ObjectId): Promise<UserDocument> {
    const user = await this.users.findOne({ _id: userId });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async ensureAnotherActiveAdmin(excludedId: ObjectId): Promise<void> {
    const otherActiveAdmin = await this.users.findOne(
      { _id: { $ne: excludedId }, role: Role.Admin, active: true },
      { projection: { _id: 1 } },
    );
    if (!otherActiveAdmin) {
      throw new ConflictException('At least one active admin account must remain');
    }
  }

  private async revokeSessions(userId: ObjectId, at: Date): Promise<void> {
    await this.sessions.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: at, updatedAt: at } },
    );
  }
}

const argonOptions: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

function parseObjectId(value: string): ObjectId {
  if (!ObjectId.isValid(value)) throw new NotFoundException('User not found');
  return new ObjectId(value);
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
