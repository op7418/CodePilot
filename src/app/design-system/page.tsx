"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  SettingsCard,
  FieldRow,
  StatusBanner,
  EmptyState,
  SectionPage,
  IconAction,
} from "@/components/patterns";
import {
  CheckCircle,
  Warning,
  Info,
  Gear,
  Trash,
  Plus,
  MagnifyingGlass,
  Copy,
} from "@/components/ui/icon";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4" data-section={title}>
      <h2 className="text-lg font-semibold border-b border-border pb-2">{title}</h2>
      {children}
    </section>
  );
}

export default function DesignSystemPage() {
  return (
    <SectionPage maxWidth="lg" className="space-y-12">
      {/* ── Buttons ── */}
      <Section title="Buttons">
        <div className="flex flex-wrap gap-3">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      {/* ── Icon Actions ── */}
      <Section title="Icon Actions">
        <div className="flex gap-3">
          <IconAction icon={<Gear size={16} />} tooltip="Settings" />
          <IconAction icon={<Trash size={16} />} tooltip="Delete" />
          <IconAction icon={<Copy size={16} />} tooltip="Copy" />
          <IconAction icon={<Plus size={16} />} tooltip="Add" size="sm" />
          <IconAction icon={<MagnifyingGlass size={16} />} tooltip="Search" size="sm" />
        </div>
      </Section>

      {/* ── Inputs ── */}
      <Section title="Inputs">
        <div className="space-y-3 max-w-md">
          <Input placeholder="Default input" />
          <Input type="password" placeholder="Password input" />
          <Select defaultValue="option1">
            <SelectTrigger>
              <SelectValue placeholder="Select..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="option1">Option 1</SelectItem>
              <SelectItem value="option2">Option 2</SelectItem>
              <SelectItem value="option3">Option 3</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Section>

      {/* ── Badges ── */}
      <Section title="Badges">
        <div className="flex flex-wrap gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="outline">Outline</Badge>
        </div>
      </Section>

      {/* ── Settings Card ── */}
      <Section title="Settings Card">
        <SettingsCard title="Card with title" description="This is a description for the card.">
          <p className="text-sm text-muted-foreground">Card content goes here.</p>
        </SettingsCard>

        <SettingsCard>
          <p className="text-sm">Card without title — just content.</p>
        </SettingsCard>

        <SettingsCard className="border-primary/50 bg-primary/5" title="Active state card">
          <p className="text-sm text-muted-foreground">With custom border color for active state.</p>
        </SettingsCard>
      </Section>

      {/* ── Field Row ── */}
      <Section title="Field Row">
        <SettingsCard>
          <FieldRow label="Toggle setting" description="Enable or disable this feature">
            <Switch />
          </FieldRow>
          <FieldRow label="Select option" description="Choose your preference" separator>
            <Select defaultValue="auto">
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Text input" separator>
            <Input placeholder="Enter value" className="w-[200px]" />
          </FieldRow>
        </SettingsCard>
      </Section>

      {/* ── Status Banner ── */}
      <Section title="Status Banner">
        <div className="space-y-3">
          <StatusBanner variant="success" icon={<CheckCircle size={16} />}>
            Operation completed successfully.
          </StatusBanner>
          <StatusBanner variant="warning" icon={<Warning size={16} />}>
            This action cannot be undone.
          </StatusBanner>
          <StatusBanner variant="error" icon={<Warning size={16} />}>
            Failed to save settings. Please try again.
          </StatusBanner>
          <StatusBanner variant="info" icon={<Info size={16} />}>
            New features are available in this version.
          </StatusBanner>
        </div>
      </Section>

      {/* ── Empty State ── */}
      <Section title="Empty State">
        <EmptyState
          icon={<MagnifyingGlass size={32} />}
          title="No results found"
          description="Try adjusting your search terms or filters."
          action={<Button size="sm">Clear filters</Button>}
        />
      </Section>

      {/* ── Section Page ── */}
      <Section title="Section Page (layout)">
        <p className="text-sm text-muted-foreground">
          This entire page uses <code className="text-xs bg-muted px-1 py-0.5 rounded">SectionPage maxWidth=&quot;lg&quot;</code> for consistent max-width and spacing.
        </p>
      </Section>
    </SectionPage>
  );
}
