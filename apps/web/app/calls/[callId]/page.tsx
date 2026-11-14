import Workspace from "@/components/Workspace";
export const dynamic = "force-dynamic";
export default async function CallPage({ params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params;
  return <Workspace callId={decodeURIComponent(callId)} />;
}
