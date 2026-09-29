import { z } from 'zod';

import { problemSchema } from './errors.js';
import type { RouteDef } from './http.js';

type JsonSchema = z.core.JSONSchema.BaseSchema;

// Zod 4 নিজেই JSON Schema (draft 2020-12) লেখে — OpenAPI 3.1-এর schema হুবহু এটাই।
// io: request-এ 'input' (ক্লায়েন্ট যা পাঠায়, default-ওয়ালা ফিল্ড ঐচ্ছিক), response-এ 'output'।
// unrepresentable: 'any' — refine()-এর মতো যা JSON Schema-য় লেখা যায় না তা বাদ, throw না
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    // output-এ Zod প্রতিটা object-এ additionalProperties: false লেখে। তাহলে response-এ নতুন
    // ফিল্ড যোগ করা (যা আসলে নিরাপদ বদল) কড়া client-এর কাছে "ভাঙা" হয়ে যেত
    override: ({ jsonSchema: node }) => {
      if (io === 'output' && node.additionalProperties === false) delete node.additionalProperties;
    },
  });
  // "$schema" (কোন JSON Schema সংস্করণ) প্রতিটা schema-য় লাগে না — OpenAPI 3.1 নিজেই 2020-12
  delete json.$schema;
  return json;
}

// query-র object schema → OpenAPI-র আলাদা আলাদা parameter (?limit=50&cursor=...)
function parameters(schema: z.ZodObject | undefined, location: 'query' | 'path') {
  if (!schema) return [];
  const object = jsonSchema(schema, 'input');
  const required = new Set(object.required ?? []);
  return Object.entries(object.properties ?? {}).map(([name, property]) => ({
    name,
    in: location,
    // path parameter সবসময় বাধ্যতামূলক (OpenAPI-র নিয়ম)
    required: location === 'path' || required.has(name),
    schema: property,
  }));
}

function operation(tag: string, name: string, route: RouteDef) {
  return {
    operationId: `${tag}.${name}`,
    tags: [tag],
    summary: route.summary,
    // খালি array = লগইন লাগে না; নাহলে global Bearer
    security: route.auth === 'public' ? [] : [{ bearer: [] }],
    parameters: [...parameters(route.params, 'path'), ...parameters(route.query, 'query')],
    ...(route.body && {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: jsonSchema(route.body, 'input') } },
      },
    }),
    responses: {
      [String(route.status)]:
        route.status === 204
          ? { description: 'No content' }
          : {
              description: 'Success',
              content: { 'application/json': { schema: jsonSchema(route.response, 'output') } },
            },
      // প্রতিটা error একই আকারে — তাই প্রতি status আলাদা করে না লিখে একটা default
      default: { $ref: '#/components/responses/Problem' },
    },
  };
}

export interface OpenApiOptions {
  version: string;
  // চলমান API যে ঠিকানায় আছে; commit করা ফাইলে থাকে না, কারণ সেটা পরিবেশ-নির্ভর
  serverUrl?: string;
}

type RouteRegistry = Readonly<Record<string, Readonly<Record<string, RouteDef>>>>;

export function buildOpenApiDocument(registry: RouteRegistry, options: OpenApiOptions) {
  const paths: Record<string, Record<string, ReturnType<typeof operation>>> = {};
  for (const [tag, group] of Object.entries(registry)) {
    for (const [name, route] of Object.entries(group)) {
      // Nest/MSW-এর ":id" → OpenAPI-র "{id}"
      const path = route.path.replace(/:(\w+)/g, '{$1}');
      paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation(tag, name, route) };
    }
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Omnivo API', version: options.version },
    ...(options.serverUrl !== undefined && { servers: [{ url: options.serverUrl }] }),
    tags: Object.keys(registry).map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: { Problem: jsonSchema(problemSchema, 'output') },
      responses: {
        Problem: {
          description: 'Error, as RFC 9457 problem details',
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
          },
        },
      },
    },
  };
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
