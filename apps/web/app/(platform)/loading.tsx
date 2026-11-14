/** Shown the instant a sidebar link is clicked, while Atlas answers. */
export default function Loading() {
  return (
    <div className="p-skel" aria-busy="true" aria-label="Loading">
      <div className="p-skel-h"><i style={{ width: 120 }} /><i style={{ width: 280, height: 28 }} /></div>
      <div className="p-skel-row">{[0, 1, 2, 3].map((k) => <i key={k} />)}</div>
      <div className="p-skel-card" /><div className="p-skel-card short" />
    </div>
  );
}
