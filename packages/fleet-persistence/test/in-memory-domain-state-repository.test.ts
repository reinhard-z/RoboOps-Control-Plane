import { InMemoryDomainStateRepository } from "../src/index.js";
import { defineDomainStateRepositoryContract } from "./domain-state-repository-contract.js";

defineDomainStateRepositoryContract("InMemoryDomainStateRepository", (initialState) => {
  return new InMemoryDomainStateRepository(initialState);
});
