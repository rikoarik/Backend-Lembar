export interface RenderPdfOptions {
  pageFormat: 'A4';
  marginMm?: { top: number; right: number; bottom: number; left: number };
  printBackground?: boolean;
  locale?: string;
}

export interface RenderArtifact {
  mediaType: 'application/pdf';
  bytes: Buffer;
  byteSize: number;
  checksumSha256: string;
  rendererVersion: string;
}

export interface RenderAdapter {
  renderPdf(html: string, options: RenderPdfOptions): Promise<RenderArtifact>;
}
