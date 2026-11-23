export interface CompressedReceiptImage {
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png';
  imageDataUrl: string;
  byteSize: number;
}

const ACCEPTED_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const MAX_INPUT_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_DIMENSION_PX = 1400;
const MAX_DATA_URL_LENGTH = 420_000;

function isSupportedReceiptFile(file: File): boolean {
  if (ACCEPTED_MIME_TYPES.has(file.type.toLowerCase())) return true;
  const lowerName = file.name.toLowerCase();
  return lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || lowerName.endsWith('.png');
}

function sanitizeFileName(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, '_');
  if (!cleaned) return 'comprovante.jpg';
  return cleaned.slice(0, 140);
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Não foi possível ler a imagem selecionada.'));
    };
    img.src = objectUrl;
  });
}

export function formatFileBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export async function compressReceiptImageFile(file: File): Promise<CompressedReceiptImage> {
  if (!isSupportedReceiptFile(file)) {
    throw new Error('Selecione uma imagem válida no formato JPEG (.jpg/.jpeg) ou PNG (.png).');
  }
  if (file.size <= 0) {
    throw new Error('O arquivo selecionado está vazio.');
  }
  if (file.size > MAX_INPUT_FILE_BYTES) {
    throw new Error('A imagem original deve ter no máximo 15 MB.');
  }

  const img = await loadImageElement(file);
  const srcWidth = img.naturalWidth || img.width;
  const srcHeight = img.naturalHeight || img.height;
  if (!srcWidth || !srcHeight) {
    throw new Error('Não foi possível identificar as dimensões da imagem.');
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Seu navegador não suportou o processamento da imagem.');
  }

  const scaleAttempts = [1, 0.8, 0.6];
  const qualityAttempts = [0.82, 0.7, 0.56, 0.44];

  for (const dimScale of scaleAttempts) {
    const longestSide = Math.max(srcWidth, srcHeight);
    const baseRatio = longestSide > MAX_DIMENSION_PX ? MAX_DIMENSION_PX / longestSide : 1;
    const finalRatio = baseRatio * dimScale;

    const targetW = Math.max(1, Math.round(srcWidth * finalRatio));
    const targetH = Math.max(1, Math.round(srcHeight * finalRatio));

    canvas.width = targetW;
    canvas.height = targetH;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(img, 0, 0, targetW, targetH);

    for (const quality of qualityAttempts) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= MAX_DATA_URL_LENGTH) {
        const baseName = sanitizeFileName(file.name).replace(/\.(png|jpeg|jpg)$/i, '') || 'comprovante';
        return {
          fileName: `${baseName}.jpg`.slice(0, 140),
          mimeType: 'image/jpeg',
          imageDataUrl: dataUrl,
          byteSize: dataUrl.length,
        };
      }
    }
  }

  throw new Error(
    'A imagem ficou muito pesada mesmo após compressão. Tente recortar ou escolher outra imagem.'
  );
}
