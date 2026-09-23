'use client';

import Image from 'next/image';
import { HardDrives } from '@/components/ui/icon';
import { getProviderIconKey } from '@/lib/provider-icon-rule';
import Anthropic from '@lobehub/icons/es/Anthropic';
import OpenRouter from '@lobehub/icons/es/OpenRouter';
import Zhipu from '@lobehub/icons/es/Zhipu';
import Kimi from '@lobehub/icons/es/Kimi';
import Moonshot from '@lobehub/icons/es/Moonshot';
import Minimax from '@lobehub/icons/es/Minimax';
import Cline from '@lobehub/icons/es/Cline';
import OpenCode from '@lobehub/icons/es/OpenCode';
import Aws from '@lobehub/icons/es/Aws';
import Bedrock from '@lobehub/icons/es/Bedrock';
import Google from '@lobehub/icons/es/Google';
import Volcengine from '@lobehub/icons/es/Volcengine';
import DeepSeek from '@lobehub/icons/es/DeepSeek';
import Bailian from '@lobehub/icons/es/Bailian';
import XiaomiMiMo from '@lobehub/icons/es/XiaomiMiMo';
import Ollama from '@lobehub/icons/es/Ollama';
import OpenAI from '@lobehub/icons/es/OpenAI';
import XAI from '@lobehub/icons/es/XAI';

interface ProviderBrandIconProps {
  name: string;
  baseUrl?: string;
  size?: number;
}

interface ProviderBrandIconByKeyProps {
  iconKey: string;
  size?: number;
}

/** Shared brand renderer for catalog entries that already own a sourced key. */
export function ProviderBrandIconByKey({ iconKey: key, size = 18 }: ProviderBrandIconByKeyProps) {
  if (key === 'tokendance') return <Image src="/provider-icons/tokendance.svg" alt="" width={size} height={size} unoptimized className="shrink-0" />;
  if (key === 'openrouter') return <OpenRouter size={size} />;
  if (key === 'zhipu') return <Zhipu size={size} />;
  if (key === 'kimi') return <Kimi size={size} />;
  if (key === 'moonshot') return <Moonshot size={size} />;
  if (key === 'minimax') return <Minimax size={size} />;
  if (key === 'volcengine') return <Volcengine size={size} />;
  if (key === 'bailian') return <Bailian size={size} />;
  if (key === 'xiaomi-mimo') return <XiaomiMiMo size={size} />;
  if (key === 'ollama') return <Ollama size={size} />;
  if (key === 'openai') return <OpenAI size={size} />;
  if (key === 'xai') return <XAI size={size} />;
  if (key === 'deepseek') return <DeepSeek size={size} />;
  if (key === 'bedrock') return <Bedrock size={size} />;
  if (key === 'google') return <Google size={size} />;
  if (key === 'aws') return <Aws size={size} />;
  if (key === 'anthropic') return <Anthropic size={size} />;
  if (key === 'cline') return <Cline size={size} />;
  if (key === 'opencode') return <OpenCode size={size} />;
  return <HardDrives size={size} className="text-muted-foreground" />;
}

/** Shared brand renderer; provider name/URL matching stays in the pure rule. */
export function ProviderBrandIcon({ name, baseUrl = '', size = 18 }: ProviderBrandIconProps) {
  return (
    <ProviderBrandIconByKey
      iconKey={getProviderIconKey(name, baseUrl)}
      size={size}
    />
  );
}
