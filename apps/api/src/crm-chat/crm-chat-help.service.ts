import { log } from '@carocrm/core/logger/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { KnowledgeArticleView } from '../service-desk/knowledge-base.service.js';
import { KnowledgeBaseService } from '../service-desk/knowledge-base.service.js';

/**
 * Phase 19-CHAT.9 — CRM Help Retrieval
 * (PLAN_Phase_19_CRM_Chat.md §5.3, §17 `19-CHAT.9`).
 *
 * This service answers "how do I" questions by searching approved help sources:
 * - Knowledge Base articles (from ServiceDesk module)
 * - Entity metadata descriptions
 * - Module documentation
 *
 * Retrieved content is treated as untrusted data and never followed as instructions.
 */

export interface HelpSource {
  readonly sourceType: 'knowledge_article' | 'entity_field' | 'module_doc';
  readonly sourceId?: string | undefined;
  readonly title: string;
  readonly content: string;
  readonly route?: string | undefined;
  readonly relevanceScore?: number | undefined;
}

export interface HelpSearchResult {
  readonly query: string;
  readonly sources: readonly HelpSource[];
  readonly hasResults: boolean;
  readonly message?: string | undefined;
}

@Injectable()
export class CRMChatHelpService {
  constructor(
    @Inject(KnowledgeBaseService) private readonly knowledgeBase: KnowledgeBaseService,
  ) {}

  /**
   * Search for help content matching the user's query. Searches Knowledge Base articles first,
   * then falls back to entity metadata if no articles found.
   */
  async searchHelp(query: string): Promise<HelpSearchResult> {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return {
        query,
        sources: [],
        hasResults: false,
        message: 'Please provide a question or topic to search for.',
      };
    }

    // Try Knowledge Base articles first
    const kbArticles = await this.searchKnowledgeBase(normalizedQuery);

    if (kbArticles.length > 0) {
      return {
        query,
        sources: kbArticles,
        hasResults: true,
      };
    }

    // Fall back to suggesting that no help was found
    return {
      query,
      sources: [],
      hasResults: false,
      message: `No help articles found for "${query}". Try rephrasing your question or check the module documentation.`,
    };
  }

  /**
   * Search Knowledge Base articles by keyword overlap with title and summary.
   * Only returns published, non-internal, in-date articles.
   */
  private async searchKnowledgeBase(query: string): Promise<HelpSource[]> {
    try {
      // Get all portal-visible articles
      const articles = await this.knowledgeBase.portalArticles();

      if (articles.length === 0) {
        return [];
      }

      // Extract keywords from query (words >= 4 chars)
      const keywords = query.split(/\s+/).filter((w) => w.length >= 4);

      // Score articles by keyword overlap
      const scored = articles.map((article) => {
        const hay = `${article.title} ${article.summary ?? ''}`.toLowerCase();
        const matchCount = keywords.filter((kw) => hay.includes(kw)).length;
        const score = keywords.length > 0 ? matchCount / keywords.length : 0;

        return { article, score };
      });

      // Filter articles with any match and sort by relevance
      const matches = scored
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5) // Top 5 results
        .map(({ article, score }) => this.articleToHelpSource(article, score));

      return matches;
    } catch (error) {
      // The knowledge base may be disabled or unavailable. That is an ordinary outcome for a
      // "how do I" question, so the answer is empty rather than an error — but the reason is
      // recorded, because a silently empty help index is indistinguishable from a broken one.
      log.warn(
        {
          component: 'crm-chat',
          eventType: 'help-retrieval',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
        'Help retrieval found no source.',
      );
      return [];
    }
  }

  /**
   * Convert a Knowledge Article to a HelpSource with safe route.
   */
  private articleToHelpSource(article: KnowledgeArticleView, relevanceScore: number): HelpSource {
    return {
      sourceType: 'knowledge_article',
      sourceId: article.id,
      title: article.title,
      content: article.summary ?? '',
      route: `/entity/KnowledgeArticle/${encodeURIComponent(article.id)}`,
      relevanceScore,
    };
  }
}
