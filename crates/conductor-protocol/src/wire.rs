//! Hand-written serde helpers the generated types use (README §Hand-written parts).

/// A zod `.nullable().optional()` field: absent → `None`, `null` → `Some(None)`, a value →
/// `Some(Some(v))`. typify renders it as one `Option` with `skip_serializing_if`, which turns an
/// explicit `null` into an absent field; the generator patches those fields to use this.
/// Used with `#[serde(default, skip_serializing_if = "Option::is_none")]`.
pub mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            // Never reached with `skip_serializing_if`; `null` keeps it total.
            None | Some(None) => serializer.serialize_none(),
            Some(Some(v)) => v.serialize(serializer),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}
