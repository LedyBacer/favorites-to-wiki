import type { Logger } from "pino";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { BundleService } from "../bundles/bundle-service.js";
import { EmbeddingService } from "../embeddings/embedding-service.js";
import { ImageAnalysisService } from "../llm/image-analysis-service.js";
import { LlmClassificationService } from "../llm/llm-classification-service.js";
import {
  MediaProcessingService,
  type MediaProcessingMode,
} from "../media-processing/media-processing-service.js";
import { PreprocessingService } from "../preprocessing/preprocessing-service.js";

export interface PipelineOrchestratorOptions {
  workerId: string;
  batchSize: number;
}

export class PipelineOrchestrator {
  private readonly bundles: BundleService;
  private readonly preprocessing: PreprocessingService;
  private readonly media: MediaProcessingService;
  private readonly embeddings: EmbeddingService;
  private readonly imageAnalysis: ImageAnalysisService;
  private readonly classification: LlmClassificationService;

  constructor(
    db: Database,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.bundles = new BundleService(db);
    this.preprocessing = new PreprocessingService(db);
    this.media = new MediaProcessingService(db, config);
    this.embeddings = new EmbeddingService(db, config);
    this.imageAnalysis = new ImageAnalysisService(db, config);
    this.classification = new LlmClassificationService(db, config);
  }

  async runOnce(options: PipelineOrchestratorOptions) {
    const mediaMode = this.mediaMode();
    const summary = {
      bundles: await this.bundles.rebuildAutoBundles(),
      preprocessing: await this.preprocessing.enqueueAndProcess(
        options.workerId,
        options.batchSize,
      ),
      media: mediaMode
        ? await this.media.enqueueAndProcess(options.workerId, options.batchSize, mediaMode)
        : skippedSummary("media_provider_not_configured"),
      imageAnalysis: this.config.LLM_SERVICE_URL
        ? await this.imageAnalysis.enqueueAndProcess(options.workerId, options.batchSize)
        : skippedSummary("llm_provider_not_configured"),
      embeddings: this.config.EMBEDDING_SERVICE_URL
        ? await this.embeddings.enqueueAndProcess(options.workerId, options.batchSize)
        : skippedSummary("embedding_provider_not_configured"),
      classification: this.config.LLM_SERVICE_URL
        ? await this.classification.enqueueAndProcess(options.workerId, options.batchSize)
        : skippedSummary("llm_provider_not_configured"),
    };

    this.logger.info(summary, "Pipeline worker loop completed");
    return summary;
  }

  private mediaMode(): MediaProcessingMode | undefined {
    if (this.config.OCR_SERVICE_URL && this.config.ASR_SERVICE_URL) return "all";
    if (this.config.OCR_SERVICE_URL) return "ocr";
    if (this.config.ASR_SERVICE_URL) return "asr";
    return undefined;
  }
}

function skippedSummary(reason: string) {
  return { skipped: true, reason };
}
