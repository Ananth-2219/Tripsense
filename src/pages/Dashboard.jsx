export default function Dashboard() {
  return (
    <section aria-labelledby="dashboard-title">
      <p className="text-sm font-semibold uppercase tracking-widest text-teal-700">Your journeys at a glance</p>
      <h1 id="dashboard-title" className="mt-3 text-4xl font-bold tracking-tight">Dashboard</h1>
      <p className="mt-4 text-slate-600">Explore your recorded trips and insights here.</p>
      <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white p-8">
        <h2 className="text-lg font-semibold">No trips yet</h2>
        <p className="mt-2 text-slate-600">Your trips will appear here once recording is available.</p>
      </div>
    </section>
  )
}

