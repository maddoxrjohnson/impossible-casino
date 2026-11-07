import pytest

from api.settings import ConfigError, Settings


def test_defaults_are_chip_off() -> None:
    settings = Settings.from_env({})
    assert settings.chip_mode == "off"
    assert settings.chip_passphrase is None
    assert not settings.trust_forwarded_for


@pytest.mark.parametrize("mode", ["off", "owner", "public"])
def test_accepts_each_mode(mode: str) -> None:
    env = {"LIVE_CHIP_MODE": mode, "CHIP_PASSPHRASE": "hunter2"}
    assert Settings.from_env(env).chip_mode == mode


@pytest.mark.parametrize("mode", ["", "OWNER", " owner", "owner ", "on", "true", "0"])
def test_rejects_anything_else_as_a_mode(mode: str) -> None:
    with pytest.raises(ConfigError, match="LIVE_CHIP_MODE"):
        Settings.from_env({"LIVE_CHIP_MODE": mode, "CHIP_PASSPHRASE": "hunter2"})


@pytest.mark.parametrize("env", [{}, {"CHIP_PASSPHRASE": ""}])
def test_owner_mode_refuses_to_start_without_a_passphrase(env: dict[str, str]) -> None:
    with pytest.raises(ConfigError, match="CHIP_PASSPHRASE"):
        Settings.from_env({"LIVE_CHIP_MODE": "owner", **env})


def test_the_passphrase_stays_out_of_repr() -> None:
    settings = Settings.from_env({"LIVE_CHIP_MODE": "owner", "CHIP_PASSPHRASE": "hunter2"})
    assert "hunter2" not in repr(settings)


def test_cloud_run_turns_on_the_forwarded_header() -> None:
    assert Settings.from_env({"K_SERVICE": "impossible-casino-api"}).trust_forwarded_for


@pytest.mark.parametrize(
    "name",
    [
        "RUN_LIMIT_PER_MINUTE",
        "CHIP_LIMIT_PER_MINUTE",
        "MAX_CLIENTS",
        "MAX_BODY_BYTES",
        "MAX_CONCURRENT_RUNS",
    ],
)
@pytest.mark.parametrize("value", ["", "0", "-1", "1.5", "ten", " 5"])
def test_numbers_must_be_positive_integers(name: str, value: str) -> None:
    with pytest.raises(ConfigError, match=name):
        Settings.from_env({name: value})


def test_numbers_come_from_the_environment() -> None:
    assert Settings.from_env({"MAX_CONCURRENT_RUNS": "3"}).max_concurrent_runs == 3


def test_cors_origins_come_from_the_environment() -> None:
    env = {"CORS_ORIGINS": "https://a.example, https://b.example"}
    assert Settings.from_env(env).cors_origins == ("https://a.example", "https://b.example")


@pytest.mark.parametrize("value", ["*", "https://*.example", "a.example", ""])
def test_rejects_a_cors_wildcard_or_bare_host(value: str) -> None:
    with pytest.raises(ConfigError, match="CORS_ORIGINS"):
        Settings.from_env({"CORS_ORIGINS": value})
