"""Shared pytest setup for ctm-core."""
import pytest


@pytest.fixture(autouse=True)
def _no_open_meteo_key(monkeypatch):
    """Tests mock the FREE Open-Meteo URL; a developer's own
    OPEN_METEO_API_KEY would silently switch them to the customer endpoint.
    Tests that exercise the key set it explicitly."""
    monkeypatch.delenv("OPEN_METEO_API_KEY", raising=False)
