import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller.js';

// লেখার দিক (audit()) module না, একটা ফাংশন (common/audit) — প্রতিটা মডিউল নিজের transaction-এ ডাকে।
// এই module শুধু পড়ার দিক: viewer-এর endpoint
@Module({
  controllers: [AuditController],
})
export class AuditModule {}
