import { Controller, Get, Header, Inject } from '@nestjs/common';
import { routes } from '@omnivo/contracts';
import { buildOpenApiDocument, type OpenApiDocument } from '@omnivo/contracts/openapi';

import { Public } from '../auth/public.decorator.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';

// Scalar-এর version বাঁধা: CDN-এর "latest" একদিন বদলে গিয়ে পেজ ভাঙতে পারত
const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Omnivo API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/openapi.json' });
    </script>
  </body>
</html>
`;

// শুধু development/test-এ চালু (app.module.ts) — production-এ API-র পুরো নকশা বাইরে দেখানো হয় না।
// চুক্তির বাইরের রুট, তাই @Endpoint না; contract.spec.ts এই দুটোকে আলাদা করে চেনে
@Public()
@Controller()
export class DocsController {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  @Get('openapi.json')
  spec(): OpenApiDocument {
    return buildOpenApiDocument(routes, { version: '0.0.0', serverUrl: this.config.apiBaseUrl });
  }

  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  docs(): string {
    return DOCS_HTML;
  }
}
