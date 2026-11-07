import json
from types import SimpleNamespace

import pytest
from qiskit_ibm_runtime.fake_provider import FakeKingston

import quantum.chip
import quantum.chip_chsh
import quantum.chip_wiesner
from quantum.chip import check_budget, pending_seconds, sample
from quantum.chip_chsh import check_dials
from quantum.chip_wiesner import check_lengths
from quantum.export import collected_runs
from quantum.export_wiesner import quietest_qubits


@pytest.mark.parametrize("max_seconds", [0, -5])
def test_budget_check_refuses_a_job_with_no_real_cap(max_seconds):
    with pytest.raises(ValueError, match="cap"):
        check_budget(remaining_seconds=600, max_seconds=max_seconds)


@pytest.mark.parametrize("max_seconds", [0, -5])
def test_sample_refuses_a_job_with_no_real_cap(monkeypatch, max_seconds):
    def fail(**_):
        raise AssertionError("sampler must not be built")

    monkeypatch.setattr(quantum.chip, "SamplerV2", fail)
    with pytest.raises(ValueError, match="cap"):
        sample([], None, shots=8, max_seconds=max_seconds)


def test_sample_hands_the_cap_and_shots_to_the_sampler(monkeypatch):
    built = []

    class Sampler:
        def __init__(self, mode):
            self.options = SimpleNamespace()
            built.append(self)

        def run(self, pubs):
            return pubs

    monkeypatch.setattr(quantum.chip, "SamplerV2", Sampler)
    sample(["pub"], None, shots=8, max_seconds=30)
    assert built[0].options.max_execution_time == 30
    assert built[0].options.default_shots == 8


def test_sample_tags_the_job_when_asked(monkeypatch):
    built = []

    class Sampler:
        def __init__(self, mode):
            self.options = SimpleNamespace(environment=SimpleNamespace(job_tags=None))
            built.append(self)

        def run(self, pubs):
            return pubs

    monkeypatch.setattr(quantum.chip, "SamplerV2", Sampler)
    sample(["pub"], None, shots=8, max_seconds=30, tags=("a", "b"))
    assert built[0].options.environment.job_tags == ["a", "b"]


def test_pending_seconds_counts_caps_on_jobs_with_no_results(tmp_path):
    (tmp_path / "chsh-a.json").write_text(json.dumps({"maxSeconds": 100}))
    (tmp_path / "wiesner-b.json").write_text(json.dumps({"maxSeconds": 30}))
    (tmp_path / "chsh-c.json").write_text(json.dumps({"maxSeconds": 70, "run": {}}))
    assert pending_seconds(tmp_path) == 130
    assert pending_seconds(tmp_path / "missing") == 0


@pytest.mark.parametrize("module", [quantum.chip_chsh, quantum.chip_wiesner])
def test_submit_refuses_before_sampling_when_pending_caps_use_the_budget(monkeypatch, module):
    service = SimpleNamespace(usage=lambda: {"usage_remaining_seconds": 100})
    sampled = []
    monkeypatch.setattr(module, "QiskitRuntimeService", lambda: service)
    monkeypatch.setattr(module, "pending_seconds", lambda: 90)
    monkeypatch.setattr(module, "prepare", lambda *_: pytest.fail("must not prepare"))
    monkeypatch.setattr(module, "sample", lambda *_: sampled.append(1))
    with pytest.raises(ValueError, match="left"):
        module.submit(SimpleNamespace(max_seconds=30))
    assert not sampled


@pytest.mark.parametrize("dials", [[0.51], [0.5, 0.5], []])
def test_check_dials_refuses_what_the_export_could_not_hold(dials):
    with pytest.raises(ValueError, match="dial"):
        check_dials(dials)


def test_check_dials_accepts_grid_positions():
    check_dials([0.0, 0.03125, 1.0])


@pytest.mark.parametrize("lengths", [[9], [0], [4, 4], []])
def test_check_lengths_refuses_what_the_export_could_not_hold(lengths):
    with pytest.raises(ValueError, match="length"):
        check_lengths(lengths)


@pytest.mark.parametrize(
    ("module", "bad"),
    [
        (quantum.chip_chsh, {"dials": [0.51]}),
        (quantum.chip_wiesner, {"lengths": [4, 4]}),
    ],
)
def test_prepare_refuses_bad_input_before_touching_the_backend(module, bad):
    def fail(_):
        raise AssertionError("backend must not be read")

    with pytest.raises(ValueError):
        module.prepare(SimpleNamespace(backend=fail), SimpleNamespace(backend="ibm_x", **bad))


def test_collected_runs_refuses_two_runs_with_one_id(monkeypatch):
    record = {"run": {"id": "ibm-chip"}}
    monkeypatch.setattr("quantum.export.read_record", lambda *_: record)
    with pytest.raises(ValueError, match="ibm-chip"):
        collected_runs("chsh", ["a", "b"])


def test_quietest_qubits_skips_qubits_without_usable_calibration():
    def errors(table):
        return {key: SimpleNamespace(error=value) for key, value in table.items()}

    target = {
        "measure": errors({(0,): 0.01, (1,): 0.001, (3,): None, (4,): 0.002, (5,): 0.002}),
        "sx": {
            **errors({(0,): 0.001, (1,): 0.001, (3,): 0.001, (5,): None}),
            (2,): None,
        },
    }
    backend = SimpleNamespace(target=target, num_qubits=6)
    assert quietest_qubits(backend, 5) == [1, 0]


def test_quietest_qubits_still_ranks_a_full_chip():
    assert len(quietest_qubits(FakeKingston(), 8)) == 8
