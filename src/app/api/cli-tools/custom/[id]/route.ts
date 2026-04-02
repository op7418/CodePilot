import { NextResponse } from 'next/server';
import { deleteCustomCliTool, getCustomCliTool } from '@/lib/db';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const tool = getCustomCliTool(id);
  if (!tool) {
    return NextResponse.json({ error: 'Custom tool not found' }, { status: 404 });
  }

  deleteCustomCliTool(id);
  return NextResponse.json({ deleted: true });
}
