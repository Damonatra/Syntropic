import type { Metadata } from 'next';
import CommandTower from '@/components/backbone/command-tower';

export const metadata: Metadata = {
  title: 'The Backbone — Layer 4 Command Tower',
  description:
    'Agency-facing command center: live financial telemetry, HITL quality control, tenant enclaves, unified client inbox, and built-in executive calls.',
};

export default function BackbonePage() {
  return <CommandTower />;
}
