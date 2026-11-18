import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import { PublicUser, UserDocument, toPublicUser } from '../users/user.types';

interface AuthSessionDocument {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  previousTokenHashes: string[];
  csrfHash: string;
  expiresAt: Date;
  purgeAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface LoginResult {
  accessToken: string;
  expiresIn: number;
  user: PublicUser;
  refreshCookie: string;
  csrfToken: string;
}

interface RefreshResult {
  accessToken: string;
  expiresIn: number;
  refreshCookie: string;
  csrfToken: string;
}

interface RefreshCookieParts {
  sessionId: ObjectId;
  token: string;
}

@Injectable()
export class AuthService {
  private readonly dummyHashPromise = argon2.hash(
    randomBytes(32).toString('base64'),
    argonOptions,
  );

  constructor(
    private readonly mongo: MongoService,
    private readonly jwt: JwtService,
  ) {}

  private get users() {
    return this.mongo.db.collection<UserDocument>('users');
  }

  private get sessions() {
    return this.mongo.db.collection<AuthSessionDocument>('auth_sessions');
  }

  async login(emailInput: string, password: string): Promise<LoginResult> {
    const email = normalizeEmail(emailInput);
    const user = await this.users.findOne({ email });
    const hash = user?.passwordHash ?? (await this.dummyHashPromise);
    const passwordMatches = await argon2.verify(hash, password).catch(() => false);

    if (!user || !user.active || !passwordMatches) {
      throw new UnauthorizedException('Email atau kata sandi tidak valid');
    }

    const now = new Date();
    const sessionId = new ObjectId();
    const refreshToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = this.refreshExpiry(now);

    await this.sessions.insertOne({
      _id: sessionId,
      userId: user._id,
      tokenHash: sha256(refreshToken),
      previousTokenHashes: [],
      csrfHash: sha256(csrfToken),
      expiresAt,
      purgeAt: new Date(expiresAt.getTime() + 86_400_000),
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    return {
      accessToken: await this.createAccessToken(user),
      expiresIn: env.accessTokenTtlSeconds,
      user: toPublicUser(user),
      refreshCookie: `${sessionId.toHexString()}.${refreshToken}`,
      csrfToken,
    };
  }

  async refresh(
    refreshCookie: string | undefined,
    csrfCookie: string | undefined,
    csrfHeader: string | undefined,
  ): Promise<RefreshResult> {
    const parts = parseRefreshCookie(refreshCookie);
    const currentTokenHash = sha256(parts.token);
    const now = new Date();
    const session = await this.sessions.findOne({
      _id: parts.sessionId,
      tokenHash: currentTokenHash,
      revokedAt: null,
      expiresAt: { $gt: now },
    });

    if (!session) {
      const reusedSession = await this.sessions.findOne({
        _id: parts.sessionId,
        previousTokenHashes: currentTokenHash,
        revokedAt: null,
      });
      if (reusedSession) {
        await this.sessions.updateOne(
          { _id: reusedSession._id, revokedAt: null },
          { $set: { revokedAt: now, updatedAt: now } },
        );
      }
      throw new UnauthorizedException('Refresh session is invalid or expired');
    }

    this.assertCsrf(session, csrfCookie, csrfHeader);

    const user = await this.users.findOne({ _id: session.userId, active: true });
    if (!user) {
      await this.sessions.updateOne(
        { _id: session._id, revokedAt: null },
        { $set: { revokedAt: now, updatedAt: now } },
      );
      throw new UnauthorizedException('Refresh session is invalid or expired');
    }

    const nextRefreshToken = randomBytes(32).toString('base64url');
    const nextCsrfToken = randomBytes(32).toString('base64url');
    const expiresAt = this.refreshExpiry(now);
    const rotation = await this.sessions.updateOne(
      {
        _id: session._id,
        tokenHash: currentTokenHash,
        csrfHash: sha256(csrfCookie!),
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          tokenHash: sha256(nextRefreshToken),
          csrfHash: sha256(nextCsrfToken),
          expiresAt,
          purgeAt: new Date(expiresAt.getTime() + 86_400_000),
          updatedAt: now,
        },
        $push: {
          previousTokenHashes: {
            $each: [currentTokenHash],
            $slice: -64,
          },
        },
      },
    );

    if (rotation.modifiedCount !== 1) {
      throw new UnauthorizedException('Refresh session is invalid or expired');
    }

    return {
      accessToken: await this.createAccessToken(user),
      expiresIn: env.accessTokenTtlSeconds,
      refreshCookie: `${session._id.toHexString()}.${nextRefreshToken}`,
      csrfToken: nextCsrfToken,
    };
  }

  async logout(
    refreshCookie: string | undefined,
    csrfCookie: string | undefined,
    csrfHeader: string | undefined,
  ): Promise<void> {
    if (!refreshCookie) return;

    const parts = parseRefreshCookie(refreshCookie);
    const tokenHash = sha256(parts.token);
    const session = await this.sessions.findOne({
      _id: parts.sessionId,
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!session) return;

    this.assertCsrf(session, csrfCookie, csrfHeader);
    await this.sessions.updateOne(
      { _id: session._id, tokenHash, revokedAt: null },
      { $set: { revokedAt: new Date(), updatedAt: new Date() } },
    );
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (!ObjectId.isValid(userId)) throw new UnauthorizedException();
    const user = await this.users.findOne({ _id: new ObjectId(userId), active: true });
    if (!user || !(await argon2.verify(user.passwordHash, currentPassword).catch(() => false))) {
      throw new UnauthorizedException('Kata sandi saat ini tidak valid');
    }

    const updatedAt = new Date();
    await this.sessions.updateMany(
      { userId: user._id, revokedAt: null },
      { $set: { revokedAt: updatedAt, updatedAt } },
    );

    const passwordHash = await argon2.hash(newPassword, argonOptions);
    const update = await this.users.updateOne(
      { _id: user._id, active: true, passwordHash: user.passwordHash },
      { $set: { passwordHash, updatedAt } },
    );
    if (update.modifiedCount !== 1) {
      throw new ConflictException('Akun berubah saat kata sandi diperbarui. Coba lagi.');
    }
  }

  async getCurrentUser(userId: string): Promise<PublicUser> {
    if (!ObjectId.isValid(userId)) throw new UnauthorizedException();
    const user = await this.users.findOne({ _id: new ObjectId(userId), active: true });
    if (!user) throw new UnauthorizedException('Account is no longer active');
    return toPublicUser(user);
  }

  private assertCsrf(
    session: AuthSessionDocument,
    csrfCookie: string | undefined,
    csrfHeader: string | undefined,
  ): void {
    if (!csrfCookie || !csrfHeader || !constantTimeStringEqual(csrfCookie, csrfHeader)) {
      throw new UnauthorizedException('CSRF validation failed');
    }
    if (!constantTimeStringEqual(sha256(csrfCookie), session.csrfHash)) {
      throw new UnauthorizedException('CSRF validation failed');
    }
  }

  private async createAccessToken(user: UserDocument): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: user._id.toHexString(),
        role: user.role,
        branchId: user.branchId,
        type: 'access',
      },
      {
        secret: env.jwtAccessSecret,
        algorithm: 'HS256',
        issuer: 'italy-tracking-api',
        audience: 'italy-tracking-client',
        expiresIn: env.accessTokenTtlSeconds,
      },
    );
  }

  private refreshExpiry(from: Date): Date {
    return new Date(from.getTime() + env.refreshTokenTtlDays * 86_400_000);
  }
}

const argonOptions: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseRefreshCookie(value: string | undefined): RefreshCookieParts {
  const [id, token, extra] = value?.split('.') ?? [];
  if (!id || !token || extra !== undefined || !ObjectId.isValid(id) || !/^[A-Za-z0-9_-]{40,}$/.test(token)) {
    throw new UnauthorizedException('Refresh session is invalid or expired');
  }
  return { sessionId: new ObjectId(id), token };
}
