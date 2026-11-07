import pytest

from api.settings import ConfigError, Settings


def test_defaults_are_chip_off() -> None:
    settings = Settings.from_env({})
    assert settings.chip_mode == "off"
    assert settings.chip_passphrase is None
    assert not settings.trust_forwarded_for


@pytest.mark.parametrize("mode", ["off", "owner", "public"])
def test_accepts_each_mode(mode: str) -> None:
    env = {"LIVE_CHIP_MODE": mode, "CHIP_PASSPHRASE": "hunter2", "IBM_QUANTUM_TOKEN": "tok"}
    assert Settings.from_env(env).chip_mode == mode


@pytest.mark.parametrize("mode", ["", "OWNER", " owner", "owner ", "on", "true", "0"])
def test_rejects_anything_else_as_a_mode(mode: str) -> None:
    with pytest.raises(ConfigError, match="LIVE_CHIP_MODE"):
        Settings.from_env(
            {"LIVE_CHIP_MODE": mode, "CHIP_PASSPHRASE": "hunter2", "IBM_QUANTUM_TOKEN": "tok"}
        )


@pytest.mark.parametrize("env", [{}, {"CHIP_PASSPHRASE": ""}])
def test_owner_mode_refuses_to_start_without_a_passphrase(env: dict[str, str]) -> None:
    with pytest.raises(ConfigError, match="CHIP_PASSPHRASE"):
        Settings.from_env({"LIVE_CHIP_MODE": "owner", "IBM_QUANTUM_TOKEN": "tok", **env})


@pytest.mark.parametrize("mode", ["owner", "public"])
@pytest.mark.parametrize(
    "token", [{}, {"IBM_QUANTUM_TOKEN": ""}, {"IBM_QUANTUM_TOKEN": "  \n"}]
)
def test_chip_modes_refuse_to_start_without_the_ibm_token(
    mode: str, token: dict[str, str]
) -> None:
    with pytest.raises(ConfigError, match="IBM_QUANTUM_TOKEN"):
        Settings.from_env({"LIVE_CHIP_MODE": mode, "CHIP_PASSPHRASE": "hunter2", **token})


def test_the_token_is_stripped() -> None:
    env = {"LIVE_CHIP_MODE": "public", "IBM_QUANTUM_TOKEN": " tok\n"}
    assert Settings.from_env(env).ibm_token == "tok"


def test_off_needs_no_token() -> None:
    assert Settings.from_env({}).ibm_token is None


def test_the_secrets_stay_out_of_repr() -> None:
    settings = Settings.from_env(
        {
            "LIVE_CHIP_MODE": "owner",
            "CHIP_PASSPHRASE": "hunter2",
            "IBM_QUANTUM_TOKEN": "token-sekrit",
        }
    )
    assert settings.ibm_token == "token-sekrit"
    assert "hunter2" not in repr(settings)
    assert "token-sekrit" not in repr(settings)


def test_chip_defaults() -> None:
    settings = Settings()
    assert settings.ibm_instance == "open-instance"
    assert settings.chip_max_seconds == 10
    assert settings.chip_presses_per_day == 12
    assert settings.chip_reserve_seconds == 300


def test_chip_settings_come_from_the_environment() -> None:
    settings = Settings.from_env(
        {
            "IBM_QUANTUM_INSTANCE": "other-instance",
            "CHIP_MAX_SECONDS": "20",
            "CHIP_PRESSES_PER_DAY": "3",
            "CHIP_RESERVE_SECONDS": "100",
            "CHIP_POLL_LIMIT_PER_MINUTE": "7",
        }
    )
    assert settings.ibm_instance == "other-instance"
    assert settings.chip_max_seconds == 20
    assert settings.chip_presses_per_day == 3
    assert settings.chip_reserve_seconds == 100
    assert settings.chip_poll_limit_per_minute == 7


def test_cloud_run_turns_on_the_forwarded_header() -> None:
    assert Settings.from_env({"K_SERVICE": "impossible-casino-api"}).trust_forwarded_for


@pytest.mark.parametrize(
    "name",
    [
        "RUN_LIMIT_PER_MINUTE",
        "RUN_CAP_PER_HOUR",
        "CHIP_LIMIT_PER_MINUTE",
        "MAX_CLIENTS",
        "MAX_BODY_BYTES",
        "MAX_CONCURRENT_RUNS",
        "CHIP_MAX_SECONDS",
        "CHIP_PRESSES_PER_DAY",
        "CHIP_RESERVE_SECONDS",
        "CHIP_POLL_LIMIT_PER_MINUTE",
        "CHIP_POLL_CAP_PER_MINUTE",
    ],
)
@pytest.mark.parametrize("value", ["", "0", "-1", "1.5", "ten", " 5"])
def test_numbers_must_be_positive_integers(name: str, value: str) -> None:
    with pytest.raises(ConfigError, match=name):
        Settings.from_env({name: value})


def test_spending_defaults() -> None:
    settings = Settings()
    assert settings.max_concurrent_runs == 1
    assert settings.run_limit_per_minute == 20
    assert settings.run_cap_per_hour == 12_000


def test_numbers_come_from_the_environment() -> None:
    assert Settings.from_env({"MAX_CONCURRENT_RUNS": "3"}).max_concurrent_runs == 3


def test_cors_origins_come_from_the_environment() -> None:
    env = {"CORS_ORIGINS": "https://a.example, https://b.example"}
    assert Settings.from_env(env).cors_origins == ("https://a.example", "https://b.example")


@pytest.mark.parametrize("value", ["*", "https://*.example", "a.example", ""])
def test_rejects_a_cors_wildcard_or_bare_host(value: str) -> None:
    with pytest.raises(ConfigError, match="CORS_ORIGINS"):
        Settings.from_env({"CORS_ORIGINS": value})
