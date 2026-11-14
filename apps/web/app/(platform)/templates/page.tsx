import { TemplateGrid } from "@/components/platform/Templates";
import { templates } from "@/lib/templates";
export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const { rows, leads } = await templates();
  return (
    <>
      <header className="p-head"><div><h1>Templates</h1><span className="eyebrow">How Gomon behaves on a call. Switch any time, even mid-call.</span></div></header>
      <TemplateGrid rows={rows} leads={leads} />
    </>
  );
}
