import { z } from 'zod';

import { type ErrorCode, errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// The records a workspace can add its own fields to. Products now; customers and suppliers when
// they come (steps 15 and 17) add a line here.
export const CUSTOM_FIELD_ENTITIES = ['product'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'boolean'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export function isCustomFieldType(value: string): value is CustomFieldType {
  return CUSTOM_FIELD_TYPES.some((type) => type === value);
}

// A workspace's own field: "Generic name" on a pharma company's products, "GSM" on a knit
// factory's. The values live in the record's custom_fields column under `key`.
export const customFieldDefinitionSchema = z.object({
  id: z.uuid(),
  // z.string(), not enums: a newer server's new entity or type must not break an older client.
  // The app narrows `type` with isCustomFieldType() and skips a field it cannot draw.
  entity: z.string(),
  // The name inside custom_fields and the CSV column (cf_generic_name). Fixed once made: renaming
  // it would orphan every value already saved under the old name.
  key: z.string(),
  label: z.string(),
  type: z.string(),
  // The choices of a select; empty for the other types
  options: z.array(z.string()),
  required: z.boolean(),
  // An archived field is hidden from forms; the values saved under it stay on the records
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type CustomFieldDefinition = z.infer<typeof customFieldDefinitionSchema>;

// Lowercase letters, digits and _, starting with a letter: it becomes a CSV column name and a JSON
// key, so it stays plain ASCII whatever language the label is in
const customFieldKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, errorCode('custom_field_key_format'));

const customFieldLabelSchema = z
  .string()
  .trim()
  .min(1, errorCode('custom_field_label_required'))
  .max(60);

// The select's choices, each once (Tablet and tablet are the same choice)
const optionsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(50)
  .superRefine((options, ctx) => {
    const seen = new Set<string>();
    options.forEach((option, index) => {
      const folded = option.toLowerCase();
      if (seen.has(folded)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: errorCode('custom_field_option_twice'),
        });
      }
      seen.add(folded);
    });
  });

export const createCustomFieldInputSchema = z
  .object({
    entity: z.enum(CUSTOM_FIELD_ENTITIES),
    key: customFieldKeySchema,
    label: customFieldLabelSchema,
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: optionsSchema,
    // A yes/no field always has a value (unticked = no), so "required" means nothing there
    required: z.boolean(),
  })
  .superRefine((input, ctx) => {
    if (input.type === 'select' && input.options.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: errorCode('custom_field_options_required'),
      });
    }
  });
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldInputSchema>;

// The type and the key stay as they were made. The server checks "a select keeps a choice",
// because only it knows the field's type.
export const updateCustomFieldInputSchema = z.object({
  label: customFieldLabelSchema,
  options: optionsSchema,
  required: z.boolean(),
  version: versionSchema,
});
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldInputSchema>;

export const customFieldVersionInputSchema = z.object({ version: versionSchema });

export const customFieldListQuerySchema = z.object({ entity: z.enum(CUSTOM_FIELD_ENTITIES) });

export const customFieldListSchema = z.object({ items: z.array(customFieldDefinitionSchema) });

// ---------------------------------------------------------------------------------------------
// The values

// On the wire: key → a string (text, number, date, select) or a boolean (yes/no). A number is a
// decimal string like money, so "180" GSM never turns into 179.99999.
export const customFieldValuesSchema = z
  .record(z.string().max(40), z.union([z.string().max(200), z.boolean()]))
  .refine((values) => Object.keys(values).length <= 50, errorCode('too_long'));
export type CustomFieldValues = z.infer<typeof customFieldValuesSchema>;

type FieldRule = Pick<CustomFieldDefinition, 'key' | 'type' | 'options' | 'required'>;

const DECIMAL = /^-?\d{1,13}(?:\.\d{1,6})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// One field of a form: '' or a missing key = no value. Checked only when there is a value; then
// "required" is checked on its own, so an empty required field says "required", not "wrong format".
function stringValue(required: boolean, valid: (value: string) => boolean, code: ErrorCode) {
  return z
    .string()
    .trim()
    .max(200)
    .optional()
    .refine((value) => value === undefined || value === '' || valid(value), errorCode(code))
    .refine((value) => !required || (value !== undefined && value !== ''), errorCode('required'))
    .transform((value) => (value === '' ? undefined : value));
}

function valueSchema(field: FieldRule) {
  switch (field.type) {
    case 'number':
      return stringValue(field.required, (value) => DECIMAL.test(value), 'number_format');
    case 'date':
      return stringValue(
        field.required,
        (value) => ISO_DATE.test(value) && z.iso.date().safeParse(value).success,
        'invalid_format',
      );
    case 'select':
      return stringValue(field.required, (value) => field.options.includes(value), 'invalid_value');
    case 'boolean':
      return z.boolean().optional();
    default:
      // 'text', and a type this build does not know yet: kept as text, never lost
      return stringValue(field.required, () => true, 'invalid_value');
  }
}

// The values a record may hold, built from the workspace's active fields: the API checks a saved
// product with it, the product form uses the same schema in its resolver, and the CSV import checks
// each row with it. Unknown keys are refused (a typo in an API call, or an archived field), and
// empty values are dropped, so the column never stores "".
export function customFieldsInputSchema(fields: readonly FieldRule[]) {
  const shape = Object.fromEntries(fields.map((field) => [field.key, valueSchema(field)]));
  return z
    .strictObject(shape, { error: errorCode('custom_field_unknown') })
    .transform((values): CustomFieldValues => {
      const kept: CustomFieldValues = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string' || typeof value === 'boolean') kept[key] = value;
      }
      return kept;
    });
}

const customFieldParamsSchema = z.object({ id: z.uuid() });

export const customFieldRoutes = {
  // Every member reads them: every product form draws them
  list: defineRoute({
    method: 'GET',
    path: '/custom-fields',
    summary: "The workspace's own fields for one kind of record, archived ones included",
    auth: 'bearer',
    status: 200,
    query: customFieldListQuerySchema,
    response: customFieldListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/custom-fields',
    summary: 'Add a field of your own to a kind of record',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 201,
    body: createCustomFieldInputSchema,
    response: customFieldDefinitionSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/custom-fields/:id',
    summary: "Change a field's label, choices or whether it is required",
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: customFieldParamsSchema,
    body: updateCustomFieldInputSchema,
    response: customFieldDefinitionSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/custom-fields/:id/archive',
    summary: 'Hide a field from forms; saved values stay',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: customFieldParamsSchema,
    body: customFieldVersionInputSchema,
    response: customFieldDefinitionSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/custom-fields/:id/restore',
    summary: 'Bring an archived field back, with its saved values',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: customFieldParamsSchema,
    body: customFieldVersionInputSchema,
    response: customFieldDefinitionSchema,
  }),
};
