import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

// @Body(new ZodValidationPipe(schema)) — body unknown হিসেবে আসে, schema দিয়ে parse হয়ে টাইপ পায়
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<TSchema>
> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Check the highlighted fields and try again.',
        fieldErrors: z.flattenError(result.error).fieldErrors,
      });
    }
    return result.data;
  }
}