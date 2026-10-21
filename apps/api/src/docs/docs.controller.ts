import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { type DocsSearchResult, DocsService, type DocsTree } from './docs.service.js';

/**
 * `GET /api/v1/Docs/{tree,page/:section/:slug,search}` (PLAN_Phase_21_Documentation.md §8).
 *
 * Mounted on the static `Docs` prefix **before** the generic `:entity` wildcard, for the same reason
 * `I18n` and `Settings` are: a reader's bookmark `/api/v1/Docs/tree` must never be read as "the `tree`
 * record of entity `Docs`".
 *
 * There is no write route here. Documentation is content that ships with the release, and the switches
 * that control it live in the `docs` settings document, which is read and written through the existing
 * `/Settings/documents/docs` routes.
 */
const CACHE_CONTROL = 'private, max-age=0, must-revalidate';

@ApiTags('docs')
@Controller('api/v1/Docs')
export class DocsController {
  constructor(@Inject(DocsService) private readonly docs: DocsService) {}

  @Get('tree')
  @ApiOperation({ summary: 'The sections and pages this caller may read' })
  @ApiResponse({ status: 200, description: 'ACL-filtered documentation tree' })
  @ApiResponse({ status: 304, description: 'Unchanged since the supplied ETag' })
  @ApiResponse({ status: 403, description: 'Portal principal' })
  async tree(
    @Query('locale') locale: string | string[] | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ): Promise<DocsTree | undefined> {
    const result = await this.docs.tree(single(locale));
    return this.conditional(result, `W/"${result.hash}-${result.locale}"`, reply, request);
  }

  @Get('page/:section/:slug')
  @ApiOperation({ summary: 'One parsed page' })
  @ApiResponse({ status: 200, description: 'The page block tree' })
  @ApiResponse({ status: 301, description: 'The key was renamed; see Location' })
  @ApiResponse({ status: 304, description: 'Unchanged since the supplied ETag' })
  @ApiResponse({ status: 403, description: 'The page exists but this caller may not read it' })
  @ApiResponse({ status: 404, description: 'Unknown page, or documentation disabled' })
  async page(
    @Param('section') section: string,
    @Param('slug') slug: string,
    @Query('locale') locale: string | string[] | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ): Promise<unknown> {
    // The key is looked up in the built index, never resolved against the filesystem, so an encoded
    // traversal attempt is simply a key that does not exist (§10.1).
    const result = await this.docs.page(section, slug, single(locale));
    if (result.kind === 'redirect') {
      reply.code(301).header('location', result.to).header('cache-control', CACHE_CONTROL);
      return undefined;
    }
    return this.conditional({ page: result.page }, `W/"${result.hash}-${result.locale}"`, reply, request);
  }

  @Get('search')
  @ApiOperation({ summary: 'Ranked hits with highlighted snippet ranges' })
  @ApiResponse({ status: 200, description: 'Search results scoped to this caller' })
  @ApiResponse({ status: 403, description: 'Portal principal' })
  @ApiResponse({ status: 404, description: 'Documentation disabled' })
  @ApiResponse({ status: 422, description: 'Invalid limit' })
  async search(
    @Query('q') q: string | string[] | undefined,
    @Query('locale') locale: string | string[] | undefined,
    @Query('limit') limit: string | string[] | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DocsSearchResult> {
    // A search is scoped to the caller and changes with the corpus, so it is never cached anywhere — but
    // it does get an ETag, because a reader who presses the back button should not refetch.
    const result = await this.docs.search(single(q) ?? '', single(locale), single(limit));
    reply.header('cache-control', CACHE_CONTROL);
    return result;
  }

  /** The one conditional-GET path: an `ETag` a matching `If-None-Match` turns into an empty 304. */
  private conditional<T>(body: T, etag: string, reply: FastifyReply, request: FastifyRequest): T | undefined {
    reply.header('etag', etag).header('cache-control', CACHE_CONTROL);
    if (matches(request, etag)) {
      reply.code(304);
      return undefined;
    }
    return body;
  }
}

function matches(request: FastifyRequest, etag: string): boolean {
  const header = request.headers['if-none-match'];
  if (typeof header !== 'string') return false;
  return header
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === etag || value === '*');
}

function single<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}
