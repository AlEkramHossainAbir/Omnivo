import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import type { StorageConfig } from '../config.js';
import { STORAGE_CONFIG } from '../infra/tokens.js';

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

const HOUR_MS = 60 * 60 * 1000;

// storage-এর সাথে কথা বলার একমাত্র জায়গা — AWS SDK এর বাইরে কেউ দেখে না। MinIO, R2 আর S3 একই
// API বলে, তাই dev থেকে production-এ শুধু env বদলায়
@Injectable()
export class StorageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(STORAGE_CONFIG) private readonly storage: StorageConfig) {
    this.bucket = storage.bucket;
    this.client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
      // MinIO bucket-কে সাবডোমেইন (omnivo.localhost) না, পাথ (localhost:9000/omnivo) হিসেবে চেনে
      forcePathStyle: true,
      // SDK-র নতুন ডিফল্ট presigned PUT-এর URL-এ একটা CRC32 checksum বসায় — ফাঁকা body-র, কারণ সই করার
      // সময় ফাইল নেই। AWS S3 আসল ফাইলের সাথে সেটা মিলিয়ে আপলোড ফিরিয়ে দেয়। MinIO checksum দেখেই না
      // (যাচাই করা: ডিফল্টেও 200), তাই dev-এ সব ঠিক দেখাত আর production-এ ভাঙত — বন্ধ রাখা
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  // শুধু dev/test: `pnpm db:up`-এর পরে বাড়তি কোনো ধাপ ছাড়াই আপলোড চলে। storage বন্ধ থাকলে API
  // তবু চালু হয় (Redis-এর মতো) — শুধু আপলোড ব্যর্থ হবে, লগে কারণ
  async onApplicationBootstrap(): Promise<void> {
    if (!this.storage.createBucket) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!(error instanceof NotFound)) {
        this.logger.warn(`Can't reach storage (${String(error)}). Start it with pnpm db:up.`);
        return;
      }
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created bucket ${this.bucket}`);
      } catch (createError) {
        // From step 11 the worker checks the bucket too. Started together on an empty MinIO, both
        // see "not found" and both create it; the second one is told it already owns it — done.
        if (!(createError instanceof BucketAlreadyOwnedByYou)) throw createError;
      }
    }
  }

  // ব্রাউজার সরাসরি storage-এ PUT করে — ফাইল API সার্ভারের memory বা ব্যান্ডউইথ দিয়ে যায় না।
  // signableHeaders: ডিফল্টে SDK শুধু `host` সই করে — ContentType দিলেও! তখন ব্রাউজার image/png ঘোষণা
  // করে text/html পাঠাতে পারত (যাচাই করা: 200)। content-type সইয়ে ঢোকালে অন্য ধরন = 403
  async uploadUrl(key: string, contentType: string, expiresInSeconds: number): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-type']) },
    );
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  // পড়ার ঠিকানা এক ঘণ্টার "জানালায়" একই থাকে: সই করার সময় ঘণ্টার শুরুতে বাঁধা, মেয়াদ দুই ঘণ্টা।
  // প্রতিবার নতুন সময়ে সই করলে প্রতিটা request-এ URL বদলাত, আর ব্রাউজার একই লোগো বারবার নামাত —
  // এখন ঘণ্টাজুড়ে একই URL, তাই ব্রাউজারের cache কাজে লাগে। মেয়াদের অন্তত এক ঘণ্টা সবসময় বাকি থাকে
  // fileName: download it under this name instead of showing it in the tab (a report export).
  // filename= is the plain fallback; filename*= (RFC 6266) carries any character for browsers.
  async downloadUrl(key: string, contentType: string, fileName?: string): Promise<SignedUrl> {
    const signingDate = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
    const url = await getSignedUrl(
      this.client,
      // ResponseContentType: storage যা-ই ভাবুক, ব্রাউজার ফাইলটাকে ঠিক এই ধরন হিসেবে পায়
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: contentType,
        ...(fileName !== undefined && {
          ResponseContentDisposition: `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        }),
      }),
      { expiresIn: 2 * 60 * 60, signingDate },
    );
    return { url, expiresAt: new Date(signingDate.getTime() + 2 * HOUR_MS) };
  }

  // আপলোড সত্যিই হয়েছে কি না, আর ঘোষণার সাথে মেলে কি না — null = ফাইল নেই
  async head(key: string): Promise<{ sizeBytes: number; contentType: string } | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType ?? '' };
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  // A file the server made itself (a report export from the worker). The same key twice replaces
  // the file, so a job that runs again after a crash writes the same object, not a second one.
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
