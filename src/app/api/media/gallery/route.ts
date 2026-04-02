import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DbRow {
  id: string;
  type: string;
  prompt: string;
  model: string;
  aspect_ratio: string;
  image_size: string;
  local_path: string;
  tags: string;
  metadata: string;
  favorited: number;
  created_at: string;
  session_id: string | null;
  [key: string]: unknown;
}

function mapRow(row: DbRow) {
  // Build images array from local_path
  const images: Array<{ mimeType: string; localPath: string }> = [];
  if (row.local_path) {
    const ext = row.local_path.split('.').pop()?.toLowerCase();
    const VIDEO_MIME: Record<string, string> = {
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
      avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    };
    const IMAGE_MIME: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
      gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif',
    };
    const mimeType = (ext && VIDEO_MIME[ext]) || (ext && IMAGE_MIME[ext]) || 'image/png';
    images.push({ mimeType, localPath: row.local_path });
  }

  // Determine media type from DB type column or MIME detection
  const mediaType = row.type || 'image';

  // Parse tags JSON string to array
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags || '[]');
  } catch {
    tags = [];
  }

  // Parse reference images from metadata
  let referenceImages: Array<{ mimeType: string; localPath: string }> | undefined;
  try {
    const meta = JSON.parse(row.metadata || '{}');
    if (Array.isArray(meta.referenceImages) && meta.referenceImages.length > 0) {
      referenceImages = meta.referenceImages;
    }
  } catch {
    // ignore
  }

  return {
    id: row.id,
    type: mediaType,
    prompt: row.prompt,
    images,
    model: row.model,
    aspectRatio: row.aspect_ratio,
    imageSize: row.image_size,
    tags,
    favorited: !!row.favorited,
    created_at: row.created_at,
    session_id: row.session_id || undefined,
    referenceImages,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const tags = searchParams.get('tags');
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');
    const favoritesOnly = searchParams.get('favoritesOnly') === '1';
    const sort = searchParams.get('sort') || 'newest';
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const db = getDb();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (favoritesOnly) {
      conditions.push("mg.favorited = 1");
    }

    if (tags) {
      const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
      for (const tag of tagList) {
        conditions.push("json_each.value = ?");
        params.push(tag);
      }
    }

    if (dateFrom) {
      conditions.push("mg.created_at >= ?");
      params.push(dateFrom);
    }

    if (dateTo) {
      conditions.push("mg.created_at <= ?");
      params.push(dateTo);
    }

    const orderDir = sort === 'oldest' ? 'ASC' : 'DESC';

    let countSql: string;
    let querySql: string;

    if (tags) {
      const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
      // Use json_each to filter by tags in the JSON array
      const tagPlaceholders = tagList.map(() => '?').join(', ');
      const baseConditions = conditions.filter(c => !c.startsWith('json_each'));
      const whereClause = baseConditions.length > 0 ? `AND ${baseConditions.join(' AND ')}` : '';

      // Rebuild params without tag params, then add them at the right positions
      const nonTagParams: unknown[] = [];
      if (dateFrom) nonTagParams.push(dateFrom);
      if (dateTo) nonTagParams.push(dateTo);

      countSql = `
        SELECT COUNT(DISTINCT mg.id) as total
        FROM media_generations mg, json_each(mg.tags)
        WHERE json_each.value IN (${tagPlaceholders}) ${whereClause}
      `;

      querySql = `
        SELECT DISTINCT mg.*
        FROM media_generations mg, json_each(mg.tags)
        WHERE json_each.value IN (${tagPlaceholders}) ${whereClause}
        ORDER BY mg.created_at ${orderDir}
        LIMIT ? OFFSET ?
      `;

      const countResult = db.prepare(countSql).get(...tagList, ...nonTagParams) as { total: number };
      const rows = db.prepare(querySql).all(...tagList, ...nonTagParams, limit, offset) as DbRow[];

      return NextResponse.json({ items: rows.map(mapRow), total: countResult.total });
    } else {
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const nonTagParams: unknown[] = [];
      if (dateFrom) nonTagParams.push(dateFrom);
      if (dateTo) nonTagParams.push(dateTo);

      countSql = `SELECT COUNT(*) as total FROM media_generations mg ${whereClause}`;
      querySql = `SELECT * FROM media_generations mg ${whereClause} ORDER BY mg.created_at ${orderDir} LIMIT ? OFFSET ?`;

      const countResult = db.prepare(countSql).get(...nonTagParams) as { total: number };
      const rows = db.prepare(querySql).all(...nonTagParams, limit, offset) as DbRow[];

      return NextResponse.json({ items: rows.map(mapRow), total: countResult.total });
    }
  } catch (error) {
    console.error('[media/gallery] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch gallery' },
      { status: 500 }
    );
  }
}
