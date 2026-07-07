export default function StationSelector({ stations, selected, onChange }) {
  return (
    <select value={selected || ""} onChange={(e) => onChange(e.target.value)}>
      {stations.length === 0 && <option value="">No stations yet</option>}
      {stations.map((s) => (
        <option key={s.station_id} value={s.station_id}>
          {s.station_id}
          {s.device_id ? ` (${s.device_id})` : ""}
        </option>
      ))}
    </select>
  );
}
