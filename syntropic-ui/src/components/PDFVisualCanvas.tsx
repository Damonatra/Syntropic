"use client";

import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export interface BBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  coord_origin?: string;
  kind?: "text" | "table";
}

interface PDFVisualCanvasProps {
  pdfUrl: string;
  pageNumber: number;
  highlightBoxes: BBox[];
  onPageCountChange?: (pageCount: number) => void;
  onError?: (message: string) => void;
}

interface PageGeometry {
  pageView: number[];
  transform: number[];
  width: number;
  height: number;
}

const RENDER_SCALE = 1.35;

export const PDFVisualCanvas: React.FC<PDFVisualCanvasProps> = ({
  pdfUrl,
  pageNumber,
  highlightBoxes,
  onPageCountChange,
  onError,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageGeometry, setPageGeometry] = useState<PageGeometry | null>(null);

  useEffect(() => {
    let active = true;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | undefined;
    let pdf: PDFDocumentProxy | undefined;
    setPdfDocument(null);
    setPageGeometry(null);
    onPageCountChange?.(0);

    async function loadPDF() {
      try {
        loadingTask = pdfjsLib.getDocument(pdfUrl);
        pdf = await loadingTask.promise;
        if (!active) return;
        onPageCountChange?.(pdf.numPages);
        setPdfDocument(pdf);
      } catch (error) {
        if (active) {
          onError?.(
            error instanceof Error ? error.message : "Could not load the PDF.",
          );
        }
      }
    }

    void loadPDF();

    return () => {
      active = false;
      if (pdf) void pdf.destroy();
      else if (loadingTask) void loadingTask.destroy();
    };
  }, [pdfUrl, onPageCountChange, onError]);

  useEffect(() => {
    if (!pdfDocument) return;
    const document = pdfDocument;
    let active = true;
    let cancelRender: (() => void) | undefined;
    setPageGeometry(null);

    async function renderPage() {
      try {
        if (
          !Number.isInteger(pageNumber) ||
          pageNumber < 1 ||
          pageNumber > document.numPages
        ) {
          throw new RangeError(
            `Page ${pageNumber} is outside the PDF page range (1-${document.numPages}).`,
          );
        }

        const page = await document.getPage(pageNumber);
        if (!active) return;
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) {
          throw new Error("Could not initialize the PDF page canvas.");
        }

        const pixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(viewport.width * pixelRatio);
        canvas.height = Math.ceil(viewport.height * pixelRatio);
        const renderTask = page.render({
          canvasContext: context,
          viewport,
          transform:
            pixelRatio === 1
              ? undefined
              : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        cancelRender = () => renderTask.cancel();
        await renderTask.promise;
        if (active) {
          setPageGeometry({
            pageView: [...page.view],
            transform: [...viewport.transform],
            width: viewport.width,
            height: viewport.height,
          });
        }
      } catch (error) {
        if (active) {
          onError?.(
            error instanceof Error ? error.message : "Could not render the PDF page.",
          );
        }
      }
    }

    void renderPage();
    return () => {
      active = false;
      cancelRender?.();
    };
  }, [pdfDocument, pageNumber, onError]);

  const boxes = pageGeometry
    ? highlightBoxes.map((box, index) => {
        const { pageView, transform, width, height } = pageGeometry;
      const viewBottom = pageView[1];
      const viewTop = pageView[3];
        const topOrigin = (box.coord_origin ?? "").toLowerCase().includes("top");
        const x1 = Math.min(box.left, box.right);
        const x2 = Math.max(box.left, box.right);
        const rawY1 = Math.min(box.top, box.bottom);
        const rawY2 = Math.max(box.top, box.bottom);
        const y1 = topOrigin ? viewBottom + viewTop - rawY2 : rawY1;
        const y2 = topOrigin ? viewBottom + viewTop - rawY1 : rawY2;
        const corners = [
          [x1, y1],
          [x1, y2],
          [x2, y1],
          [x2, y2],
        ].map(([x, y]) => ({
          x: transform[0] * x + transform[2] * y + transform[4],
          y: transform[1] * x + transform[3] * y + transform[5],
        }));
        const left = Math.min(...corners.map((point) => point.x));
        const right = Math.max(...corners.map((point) => point.x));
        const top = Math.min(...corners.map((point) => point.y));
        const bottom = Math.max(...corners.map((point) => point.y));
        const valid = [
          box.left,
          box.top,
          box.right,
          box.bottom,
          left,
          right,
          top,
          bottom,
        ].every(Number.isFinite);

        if (!valid || !width || !height) return null;

        return (
          <span
            className={`bbox bbox-${box.kind ?? "text"}`}
            key={`${box.left}-${box.top}-${box.right}-${box.bottom}-${index}`}
            style={{
              left: `${(left / width) * 100}%`,
              top: `${(top / height) * 100}%`,
              width: `${((right - left) / width) * 100}%`,
              height: `${((bottom - top) / height) * 100}%`,
            }}
            title="Extracted document evidence"
          />
        );
      })
    : [];

  return (
    <div className="page-layer">
      <canvas ref={canvasRef} className="pdf-visual-canvas" />
      <div className="pdf-visual-overlay" aria-hidden="true">
        {boxes}
      </div>
    </div>
  );
};
