import { Field, Input } from "./ui";

export type LocationValues = { country: string; state: string; city: string };

export function LocationFields({
  value,
  onChange,
  company = false,
}: {
  value: LocationValues;
  onChange: (value: LocationValues) => void;
  company?: boolean;
}) {
  return (
    <>
      {(["country", "state", "city"] as const).map((key) => (
        <Field
          key={key}
          label={
            company && key !== "country"
              ? `Company ${key}`
              : key.charAt(0).toUpperCase() + key.slice(1)
          }
        >
          <Input
            value={value[key]}
            maxLength={120}
            onChange={(event) => onChange({ ...value, [key]: event.target.value })}
          />
        </Field>
      ))}
    </>
  );
}
